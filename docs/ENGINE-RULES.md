# ENGINE-RULES — قواعد الاستنتاج، مستخرجة من Traccar ومُكيَّفة لـ Traccer

مرجع تنفيذي لمحرك التتبع (`apps/api/src/modules/tracking|rules|notify`). هذا الملف **يُكمّل** `docs/CONTRACT.md`؛ وعند التعارض تُطبَّق قيود هذا الملف لأنها مبنية على سلوك Traccar المُجرَّب (`_references/traccar`) وسلوك عميل الأندرويد (`_references/traccar-client-android`).

## 0. ترتيب الـ pipeline (ضروري)
كل دفعة نقاط تُمرَّر بالترتيب، وأي نقطة تُرفض في مرحلة الفلترة **لا تُنتج أحداثًا**:

```
reorder(by clientTs) → normalize/outdated → filters → geofence membership →
speed limit resolve → motion classify → trip/stop update → rules → persist →
realtime publish → alert dispatch (push)
```
- **إعادة ترتيب قبل كل شيء**: Traccar يعيد ترتيب الوافد الخارج عن الترتيب لكل جهاز (`BufferingManager.java:101-117`، نافذة 3 ثوانٍ). دفعة الأوف لاين تصل دائمًا خارج الترتيب النسبي، فإعادة الترتيب بـ `clientTs` هي التي تجعل الخط يبدو لحظيًا.
- **النطاق قبل حد السرعة**: حد السرعة يُقرأ من النطاق الذي يحويه السواق أولًا (`OverspeedEventHandler.java:76-92`)، عند تعدد النطاقات نأخذ **الأدنى** (سياسةUni Group: الأمان أغلى).

## 1. الفلاتر (مطابقًا لـ `FilterHandler.java:169-234`، مع تكييف)
| فلتر | القاعدة عندنا | السبب |
|---|---|---|
| `invalid` | `|lat|>90 || |lng|>180` أو `accuracy > 35m` → يُخزَّن بـ `motionState=UNKNOWN` ولا يُنتج أحداثًا | منع تنبيهات وهمية |
| `outdated` | نقطة بـ GPS غير صالح → نورّث آخر إحداثيات معروفة (`OutdatedHandler.java:37-55`) | حتى لا يظهر السواق في موضع شارد |
| `future/past` | `clientTs` > الآن+5د أو أقدم من 72د → `stale: true`، يُخزَّن، لا تنبيهات فورية منه | عبث الساعة/الـ timezone |
| `duplicate` | نفس `clientTs` أو نفس `(lat,lng)` داخل 20 ث → dedupe عبر `Position.ingestHash` | إعادة الإرسال بعد انقطاع |
| `static` | `speed==0 && Δpos==0` لـ 6 نقاط → نُبقي الأولى فقط | تضخيم قاعدة البيانات |
| `distance`/`minPeriod` | لا نُسجل نقطة قبل مرور `MIN_INTERVAL_S=2` أو تحرك 10م | عمر البطارية |
| `maxSpeed` (مشتق) | لو `Δdistance/Δt > 250km/h` → ارفض النقطة واعتبرها UNKNOWN | قفزات GPS |
| `dailyLimit` | لا نرفض، لكن نوسم اليوم كـ `degraded` لو تجاوزنا السقف | حماية من جهاز خارج السيطرة |

## 2. تجاوز السرعة
- المقارنة `speed > limit * multiplier` (Strict `>`)، `multiplier = 1.0` افتراضيًا.
- **المدة أهم من عدد العينات**: التنبيه يشتغل بعد `speedingMinDurationS = 15` ثانية استمرار (تعادل 3 عينات كل 5 ث)، ويظل الاشتعال متجددًا كل `120` ثانية ما دام التجاوز مستمرًا (سلوك Traccar: state يبقى true والمؤقّت يُصفَّر).
- **التعافي (recovery)**: أول نقطة ≤ الحد تُغلق الحالة فورًا. بدون هذا البند يتأرجح التنبيه.
- الحالة تُخزن على مستوى الجهاز/السواق: `RuleOverride` + عمود حالة داخلي في الـ service (وwatermark في `Setting` عند إعادة التشغيل) — لأن الذاكرة تضيع مع الـ restart تمامًا كما في `CacheManager`.

## 3. النطاقات (Geofences)
- الدائرة: Haversine `<= radius` (`GeofenceCircle.java:40`). المضلع: ray-casting مع pre-filter بصندوق إحاطة (bbox) — **مهم في SQLite/بدون PostGIS**: احسب الـ bbox واحفظه مع الـ polygon (نص JSON) بدل إعادة تحليل كل نقطة.
- نوع ثالث مفيد لنا: **خط سير مصرّح** (polyline buffer) بمسافة `polylineDistance = 25m` — لطرق القوافل بين المواقع (يُفعَّل لاحقًا بأداة رسم في الداش بورد).
- الأحداث من **فرق المجموعات**: `insideSet(t) \ insideSet(t-1)` = دخول، والعكس خروج (`GeofenceEventHandler.java:53-85`). لا تنبيه خروج إلا لو استمر خارج كل نطاقات السواق `geofenceGraceS = 120` ثانية.
- تقويم/وردية: نطاق قد يكون مطلوبًا فقط داخل زمن الوردية — نستخدم `ShiftAssignment` كفرضية صلاحية بدل `calendarId`.

## 4. الرحلات والتوقفات (منطق Traccar الحديث `NewMotionProcessor`)
- بدء رحلة: مسافة ≥ `minDistance = 200m` من آخر نقطة حدث.
- نهاية/توقف: كل النقاط داخل نافذة stayed ضمن `minDistance` لمدة ≥ `minDuration = 180s`.
- **`stopGap = 3600s`**: لو وجدت فجوة أكبر من ساعة بين نقطتين — ركّب حدث توقف ثم بداية رحلة ثم توقف **بتواريخ رجعية** من النقاط نفسها. ده بالضبط ما يجعل بيانات الأوف لاين المعاد بثها تظهر كرحلات حقيقية وليس كفجوة.
- حد التوقف للتنبيه الإداري يبقى `stopAlertMin = 30` دقيقة (مشروط بنوع التوقف: `UNPLANNED` فقط، والتوقف داخل موقع شركة = `PLANNED` بلا تنبيه).

## 5. التصنيف الحركي (طلب المستخدم: «ماشي / راكب / واقف»)
عتبات `docs/CONTRACT.md §5` مع إضافة: لا تغيير حالة قبل `HYSTERESIS_SAMPLES=3`، ولا حالة من نقطة `accuracy > 35m`. لو الجهاز أبلغ `motion` نفسه (مثلًا accelerometer) نثق في الجهاز أولًا (سلوك `MotionHandler.java:37-41`).

## 6. الفرملة/التسارع العنيف
- طولي فقط من حسابنا: `a = Δspeed(m/s) / ΔclientTime`؛ `a ≥ 2.8 m/s²` ⇒ `HARSH_ACCELERATION`، `a ≤ -2.2 m/s²` ⇒ `HARSH_BRAKING` (`BehaviorEventHandler.java:41-52`).
- **الانعطاف العنيف**: في Traccar يجي من الجهاز كـ alarm وليس من السيرفر؛ عندنا يُحسب تقريبيًا `v²/R` من تغيّر الاتجاه إن توفرت عينات كثيفة، وإلا لا تُطلقه (لا اختراع تنبيهات مش موثوقة).

## 7. التوصيل والإشعارات (قصة «ولا حدث يضيع»)
- كل alert يُخزن أولًا ثم يُوزَّع — نفس مبدأ `NotificationManager.java:83-153`.
- **نافذة التقادم**: Traccar يسكت عن الأحداث الأقدم من 15 دقيقة (`notificator.timeThreshold`). عندنا قاعدة أدق لأن المستخدم نفسه طلب الأوف لاين يظهر «كأنه كان أونلاين بالظبط»:
  - تنبيهات `replayed=true` تُعرض في الداش بورد كلها مع وسم «مُستعاد» و**Push يُرسل فقط للـ CRITICAL**، والـ WARNING/INFO تُجمَّع في ملخص واحد لكل سواق (`BUFFER_REPLAYED` بـ `meta.count`) حتى لا ينهال 40 إشعارًا على المشرف عند رجوع الإنترنت.
  - أي محاولة توصيل فاشلة تُسجَّل في `NotificationLog` بحالة `FAILED` مع `attempts` وإ Retry مجدول — الإشعار المفقود عيب نظام لا حادث عرضي.
  - تنظيف التوكنات الميتة تلقائيًا عند `UNREGISTERED/INVALID_ARGUMENT` من FCM (مثل `NotificatorFirebase.java:160-184`).
- Cooldown افتراضي 180 ث لنفس `(employeeId,type)`، ويُكسر عند تصاعد الخطورة أو `force` (Traccar نفسه لا يملك repeat؛ الـ dedupe عنده في الـ handlers المشتعلة بحوافها — لذلك الحالة المخزّنة أهم من الكاونتر).

## 8. مخزن العميل في الفلاتر (Flutter)
- جدول `position` بمفتاح autoincrement + **حذف بعد الإقرار** (FIFO) — مثل `TrackingController.kt:119-179`، لكن مع:
  - سقف `20000` صف (حذف الأقدم) لأن Traccar بلا سقف وهذا خطر علىالتخزين،
  - مفتاح dedupe `(employeeId, clientTs, lat, lng)` لأن إعادة التشغيل قد تُرسل نفس الصف مرتين،
  - `ORDER BY clientTs` لا `rowid` لو الجهاز غيّر ساعتها،
  - حذف صفوف الجهاز القديم عند تغيّر `deviceId` (نفس حركة Traccar عند إعادة التسجيل).

## 9. مبادئ SQLite/بلا PostGIS
كل الهندسة حسابية في TypeScript (turf + Haversine) — لا امتدادات مكانية مطلوبة. لكن يجب: bbox محفوظ مع كل polygon، إعادة ترتيب الدفعات في الذاكرة مع watermark محفوظ، وحالة الأحداث (overspeed/geofence/motion) محفوظة في جدول (أو Setting) لا في الذاكرة فقط، لأن الذاكرة تضيع عند إعادة التشغيل ونفقد دقة الحواف.
