# CONTRACT — المرجع الملزم

كل موديول (API / Flutter / Dashboard) لازم يلتزم بالأسماء والأشكال هنا. أي تغيير في العقد يتوثّق أولًا في هذا الملف.

Base URL: `/api/v1` — كل الطلبات محمية بـ `Authorization: Bearer <accessToken>` ما عدا `/auth/login` و `/health`.
كل التواريخ ISO-8601 UTC. الإحداثيات WGS84 عشرية (`lat`, `lng`) بنظام `decimal` degrees.

---

## 1. الأدوار والحماية

`ADMIN` (IT) · `SUPERVISOR` (متابعة التتبع) · `HR` (الموارد البشرية) · `EMPLOYEE` · `DRIVER`

- `EMPLOYEE`/`DRIVER` يرون سجلهم الشخصي فقط (`/me/**`)، **وكل تعاملهم من تطبيق الموبايل**: لو فتحا الداش بورد تُعرض شاشة «الدخول من التطبيق» بلا أي تابات.
- `HR` = شؤون الحضور فقط: `/attendance` (قراءة وتصدير) و`/leave` و`/places/org-tree|sites|sites/:id|zones|zones/:id` و`/employees` (القائمة فقط — تفاصيل الموظف فيها موقعه الحي) و`/reports/daily|timesheet|exceptions`. **لا رحلات، لا خط سير، لا أميال، لا مراقبة حية، لا تنبيهات** — `route`/`mileage`/`live-kpis` و`/positions/live` و`/employees/live` و`/places/fences` و`/notifications/log` مغلقة دونه، و`GET /settings` يوصله بلا سجل تسليم التنبيهات.
- `SUPERVISOR` = حركة السواقين: `/positions/live`, `/trips`, `/drivers/presence`, التنبيهات، والتقارير التشغيلية. يرى بيانات من هم داخل نطاق رقابته (`scopeOrgUnitId` اختياري).
- `ADMIN` (IT) يمرّ من أي فحص أدوار (يشوف كل شيء للتشخيص)؛ إنشاء/تعديل النطاقات والقواعد والمزامنة والأجهزة: `ADMIN` فقط، ما عدا استثناء `HR` في `/settings` (بالأسفل).
- ack/resolve/تعليق على التنبيهات: `SUPERVISOR` + `ADMIN`.
- `PATCH /settings`: `ADMIN` بلا قيود؛ `HR` مسموح له بمفاتيح الحضور فقط — `shiftGraceMin` و`attendanceStrictReject` — وأي مفتاح تاني يرجع `403 FORBIDDEN_SETTING_KEY`.
- حسابات `HR` تُنشأ وتُعدّل من `/users` (قائمة `MANAGEABLE_ROLES`).

## 2. Auth & Devices

| Method | Path | الوصف |
|---|---|---|
| POST | `/auth/login` | `{ identifier, password }` → `{ accessToken, refreshToken, user, mustChangePassword, changeOnLogin }` |
| POST | `/auth/refresh` | `{ refreshToken }` → نفس شكل `login` تمامًا (`{ accessToken, refreshToken, user, mustChangePassword, changeOnLogin }`). **لا يدوّر الـ refreshToken**: يُصدر access جديد ويزحلق انتهاء الجلسة، ويعيد نفس التوكن الذي قُدّم — الموبايل أكثر من isolate (واجهة/تتبع/WorkManager) يحدّثونه بأنفسهم، والتدوير كان يجعل ثانيهم يقدّم توكنًا قديمًا فيُقرأ كسرقة وتُلغى جلسة السائق في منتصف الوردية |
| GET | `/auth/me` | → `{ user, profile, permissions[], mustChangePassword, scopeOrgUnitId }` — `profile` = ملفه الوظيفي (Employee) أو `null`، و`scopeOrgUnitId` نطاق رقابة المشرف (من الداتا بيز، لا من التوكن) |
| POST | `/auth/logout` | `@Public` (لا يشترط bearer ساري): `{ refreshToken }` → يلغي تلك الجلسة بالتحديد، أو `{}` + bearer → يلغي كل جلسات المستخدم (الداش بورد يسجّل الخروج بجسم فارغ). بلا الاثنين → `401 INVALID_REFRESH_TOKEN`. جسم التوكن يُتحقق من توقيعه قبل أي إلغاء، وهو ملكية الجلسة |
| POST | `/devices/register` | `{ token, platform: "android"\|"ios", appVersion, deviceId }` — idempotent بـ `deviceId` |
| POST | `/devices/heartbeat` | `{ deviceId, battery?, tracking: boolean, gpsEnabled: boolean, online: boolean }` كل 5 د |
| POST | `/devices/toggle-event` | `{ deviceId, kind: "GPS_OFF"\|"GPS_ON"\|"DATA_OFF"\|"DATA_ON"\|"APP_KILLED"\|"BUFFER_FLUSH" }` |
| POST | `/devices/help` | `{}` — **للسواق فقط** (`@Roles(DRIVER)`؛ الموظف العادي ما لوش حالة ميدانية يطلب فيها عونًا). لا يحمل `deviceId`: الهوية تُقرأ من التوكن والجهاز الملحق به يُرفق في `meta`. يمرّ بنفس قناة التنبيهات (`ALERT_DISPATCHER`) بـ `HELP_REQUESTED` + `CRITICAL` + `force: true`، فيصل `alert:new` لكل `ADMIN`/`SUPERVISOR` مع push في نفس الثانية. لا بوابة «يوم مفتوح» ولا cooldown — طلب مساعدة إنسان ليس قاعدة تجاوزت حدًا |

`user` = `{ id, identifier, name, role, employeeId, phone, siteId?, zoneId?, driver: boolean }`

## 3. Attendance (تشيك ان / أوت)

| Method | Path | الوصف |
|---|---|---|
| POST | `/attendance/check-in` | `{ lat, lng, accuracy?, deviceId }` |
| POST | `/attendance/check-out` | `{ lat, lng, accuracy?, deviceId }` |
| GET | `/attendance/me/today` | سجل اليوم + الحالة الحالية |
| GET | `/attendance/me/history?from&to&page` | سجل الموظف/السواق الشخصي فقط — `{ items, total, page, pageSize }` (بلا تغيير) |
| GET | `/attendance` | فلترة: `from,to,userId,siteId,zoneId,status,page,pageSize,format` — قراءة لـ `ADMIN` **و`SUPERVISOR`**. الوضع الافتراضي (JSON) يُخرج مغلّف `{ records, total, page, pageSize, stats }`. مع `?format=csv` يرجع **نص CSV خام** (`text/csv`) وليس JSON — نفس مخرج `/attendance/export`. |

قواعد التحقق: النقطة لازم تقع داخل نطاق العنصر (`Site` للموظف / `Zone` للسواق) حسب `GeoShape`.
**صيغة المضلع:** canonical هي `[[lat,lng],…]`، والسيرفر بيتعامل مع `[[lng,lat],…]` (شكل GeoJSON اللي بيرسمه الداش بورد) تلقائيًا — الاتجاه يُحدّد بمطابقة مركز الحلقة مع `lat/lng` المُعلَن للنطاق (`GeoService.ringOf`)، وأي حلقة أقل من 3 نقاط أو بإحداثيات غير صحيحة تُرفض بـ `POLYGON_INVALID`. مخرج `GET /places/fences` هو GeoJSON بصيغة `[lng,lat]` كما هو متعارف.
**نجاح `check-in`/`check-out`** يُخرج: `{ status, fenceName, distanceToCenterM, allowedFences[], record }` حيث `status` = `VALID` أو `OUT_OF_FENCE`، و`allowedFences[]` عناصر `{ id, name, kind: "SITE"|"ZONE" }`.

**حارس الإنهاء في التطبيق:** «إنهاء اليوم» لا يعمل بضغطة واحدة — الزر يطلب ضغطًا متصلًا **٣ ثوانٍ** (شريط تقدّم يمتلئ، والرفع قبل اكتماله يُظهر تنبيهًا ولا يُنهي شيئًا)، بينما «بدء اليوم» يبقى ضغطة عادية. الحارس على العميل وحده: `POST /attendance/check-out` يقبل الطلب متى وصل بلا أي دليل على المدة، فهو يمنع اللمسة الخاطئة ولا يمنع قرارًا متعمّدًا.

سياسة الرفض الصارم (Strict-reject) تُقرأ من **`Setting(key='rules.global')` بحقل `attendanceStrictReject`** (عالمي، يسري على كل النطاقات بما فيها المناطق لأن جدول `Zone` لا يعمود `strictReject` له)، أو من **`Site.strictReject`** لموظفي المواقع (غير السواقين). `AttendanceService` يخبّئ هذا الإعداد ~30 ثانية مثل `RulesService`.

`OUT_OF_FENCE` **لا يُرفض الطلب افتراضيًا**؛ يُسجَّل السجل مع راية `exception: true`، وراية `replayed: true` مشتقّة (لا يوجد عمود `replayed` في `AttendanceRecord` — تُحسب من وجود نقاط `buffered/stale` لنفس الموظف+يوم العمل)، ويُطلق تنبيه `CHECK_IN_OUT_OF_FENCE`. **أما إذا فعّلت Strict-reject** فالخارج عن النطاق يُرفض بـ **HTTP `422`** بالكود `FENCE_VIOLATION` وجسم غنيّ:
```json
{
  "code": "FENCE_VIOLATION",
  "statusCode": 422,
  "message": "تشيك ان خارج النطاق",
  "fenceName": "منطقة القاهرة الكبرى",
  "distanceToCenterM": 5120.4,
  "allowedFences": [{ "id": "z1", "name": "منطقة القاهرة الكبرى", "kind": "ZONE" }],
  "supervisorPhone": "+201000000000"
}
```
`supervisorPhone` = هاتف أول `SUPERVISOR` داخل وحدة الموظف التنظيمية، وإلا هاتف أول `ADMIN`، وإلا `null`.

**مغلّف `GET /attendance`**: `records[]` بمفاتيح مطابقة لنوع الداش بورد `AttendanceRecord` (`userId` = معرّف الموظف)، مثل: `{ id, userId, userName, siteId, siteName, zoneId, zoneName, date, checkInTs, checkOutTs, checkInStatus, checkOutStatus, distanceToCenterM, fenceName, exception, replayed }`. `stats` = `{ present, missingCheckout, outOfFence, sites:[{id,name,count,present,expected}], zones:[{id,name,count,present}] }` محسوب على كامل المجموعة المفلترة (تُستخدم لملء قوائم الفلترة).

ممنوع تشيك ان مزدوج: `ALREADY_CHECKED_IN` (`409`)، و`check-out` بلا سجل مفتوح ⇒ `NO_OPEN_RECORD` (`409`). نهاية الوردية بفترة سماح `shiftGraceMin=30` (أو `schedule.graceMin`) ثم حالة `MISSING_CHECKOUT` وتنبيه `CHECKOUT_MISSING`.

**أثر الإجازة المعتمدة (انظر 3.1):** إذا كان يوم العمل داخل إجازة `APPROVED` لنفس الموظف، فـ `check-in` يُرفض بـ **`409 ON_APPROVED_LEAVE`** وجسم `{ code, leave: { id, dateFrom, dateTo } }`، و`GET /attendance/me/today` يرجع `currentStatus: "ON_LEAVE"` مع حقل `leave` — والتطبيق يقفل زر «بدء اليوم» في اليوم ده. اليوم اللي فيه حضور فعلي يكسب: الإجازة لا تلغي سجل الحضور ولا تُولّد صف ثاني. `GET /attendance` (و`?format=csv` و`/attendance/export`) يضيف **صفوفًا مُولَّدة** بحالة `LEAVE` لكل يوم إجازة معتمدة بلا سجل حضور (`id = "leave:<leaveId>:<date>"` — صف لكل يوم، `checkInTs/checkOutTs = null`، `exception = false`)، و`stats.onLeave` يعدّها، و`?status=LEAVE` يُرجع صفوف الإجازات فقط. `/reports/timesheet` يدمج الأيام دي كصفوف `status: "LEAVE"` بـ `hoursWorked: 0`، و`/reports/daily` عنده `kpis.onLeave` و`absent = النشطون − الحاضرون − أيام الإجازة`.

### 3.1 Leave (الإجازات)

`LeaveRequest{ id, employeeId, dateFrom, dateTo, reason, status, requestedAt, decidedById, decidedAt, decisionNote }` — التواريخ `YYYY-MM-DD` (يوم واحد ⇒ `dateTo = dateFrom`)، و`status ∈ PENDING | APPROVED | REJECTED | CANCELLED` (`LEAVE_STATUS`).

| Method | Path | الوصف |
|---|---|---|
| POST | `/leave` | `{ dateFrom, dateTo?, reason? }` لأي مستخدم ليه ملف موظف → طلب `PENDING`. أخطاء: `NO_EMPLOYEE_PROFILE`، `LEAVE_BAD_RANGE`، `LEAVE_OVERLAP` (`409`) لو اتداخل مع طلب `PENDING`/`APPROVED` قائم |
| GET | `/leave/mine?status&from&to` | طلبات المستخدم نفسه فقط (تُستخدم في شاشة الإجازات بالتطبيق) |
| PATCH | `/leave/:id/cancel` | صاحب الطلب وهو لسه `PENDING` → `CANCELLED`؛ وإلا `403 LEAVE_NOT_YOURS` أو `409 LEAVE_NOT_PENDING` |
| GET | `/leave?status&from&to&page&pageSize` | **`HR` + `ADMIN` فقط** → `{ items, total, pendingCount }`، والعنصر فيه `employeeName`/`employeeExternalId`/`kind`/`decidedByName` |
| POST | `/leave/:id/approve` | `HR` + `ADMIN`، جسم اختياري `{ note }` → `APPROVED`. القرار نهائي: `409 LEAVE_ALREADY_DECIDED` لو اتخاذ قرار سابقًا |
| POST | `/leave/:id/reject` | نفس الشيء → `REJECTED` |

موافقة الـ HR لا تكتب سجل حضور — هي بتغيّر نوع اليوم في تقارير الحضور من «غياب» إلى «إجازة»، وببت زر بدء اليوم في التطبيق.

## 4. Position ingest (التتبع + إعادة البث أوف لاين)

`POST /positions/batch` — **نقطة الدخول الوحيدة** لبيانات الموقع.

**موظف المواقع (`Employee.kind = EMPLOYEE`) ممنوع من التتبع أصلًا:** الرفع بيوافق بس لما صاحب الجهاز `kind = DRIVER`، وإلا `400 TRACKING_NOT_ALLOWED_FOR_EMPLOYEE`. المطلب المطلوب للموظف العادي هو حضور وانصراف فقط، فأي نقاط أو رحلات أو أحداث من حسابه تُرفض على السيرفر (رسائل العميل وحدها ما تكفيش).

```json
{
  "deviceId": "string",
  "batchSeq": 42,
  "positions": [
    { "clientTs": "2026-10-22T06:31:04.000Z", "lat": 30.0444, "lng": 31.2357,
      "speed": 42.5, "bearing": 118, "accuracy": 8.0, "altitude": 74,
      "battery": 81, "provider": "gps", "motionState": "RIDING", "buffered": true }
  ]
}
```

- `speed` بـ km/h (مقدّم من الجهاز)، `clientTs` = وقت الالتقاط الفعلي على الجهاز، `serverTs` يضيفه السيرفر للتحقق فقط.
- **Idempotency / dedupe:** لكل نقطة بصمة `ingestHash = sha1("employeeId|clientTs(ISO)|lat.toFixed(6)|lng.toFixed(6)")` مخزّنة بعمود `Position.ingestHash @unique`. تكرار البصمة (خطأ `P2002`) يُحتسب في `deduped` **بدون خطأ ودون تكرار الإدراج** — ده أساس مبدأ "إعادة البث تظهر كأنها لحظية". (المفتاح على **`employeeId`** وليس معرّف تسجيل الدخول.) `batchSeq` لكل جهاز يُحدَّث تنازليًا لكن الدفعات خارج الترتيب تظل تُقبَل.
- الحد الأقصى **500 نقطة/طلب**، وأكثر من ذلك ⇒ `400 BATCH_TOO_LARGE`. نقاط أقدم من نافذة إعادة البث `replayMaxAgeHours=72` (قابلة للتجاوز عبر `rules.global`) تُخزَّن وتُوسم `stale: true`؛ والنقاط التي وصلت متأخرة (>3 دقائق) أو براية `buffered: true` من الجهاز تُوسم `buffered: true`. **النقاط المعاد بثها تحتفظ بـ `clientTs` الأصلي** (زمن الالتقاط على الجهاز) — المعالجة تُرتّبها بـ `clientTs` فتظهر كأنها لحظية.
- وصول أي دفعة فيها نقاط `buffered` يُطلق تنبيه **`BUFFER_REPLAYED`** (INFO، `replayed: true`) بمحتوى `meta: { count, buffered, replayGap }` (المعدود يشمل الفجوة المُغلقة أمام آخر نقطة لحظية).
- Response: `{ accepted, deduped, rejected: [{ index, reason }], alertsRaised, nextServerTs }` — `reason` مثل `BAD_CLIENTTS`/`BAD_COORDS`/`BAD_SPEED`/`NO_EMPLOYEE`/`BATCH_*`.
- `GET /positions/live?since=<ts>` → `{ positions: LivePosition[], serverTs }` (المُوسَّع، انظر §7). `GET /positions/route?userId&date` → `{ userId, employeeId, date, userName, distanceKm, replayed, replayedPoints, geojson, points[], stops[], gaps[], positions[], pointCount }` (GeoJSON `[lng,lat]` + فجوات).
- **قراءة التتبع للـ ADMIN/SUPERVISOR فقط:** `GET /positions/live` و`/positions/route` و`/trips` و`/drivers/presence` كلها `@Roles(ADMIN,SUPERVISOR)` — توكن سواق ما ينفعش يسحب يوم سواق تاني، والـ HR ما لوش حاجة معاهم خالص (§1).

## 5. Motion-state classifier (مشروع مشترك API/Flutter)

مدخلات: `speedKmh`, `accuracyM`, ناقل الاتجاه، الزمن، و`stepsPerMin`/`motionEnergy` من مستشعر الحركة (اختيارية — جهاز بعتهمش بيتحكم في الأرض لوحدها). ثوابت في `packages/shared/src/constants.ts` ويجب مطابقتها في `apps/mobile/lib/core/traccer_constants.dart` (الحارس: `tools/generate_constants_golden.mjs` + `test/constants_golden_test.dart`):

```
STATIONARY_SPEED_KMH   = 1.5    WALK_MAX_KMH = 7.0     RIDE_MIN_KMH = 7.0
SPEED_EMA_ALPHA        = 0.35    HYSTERESIS_SAMPLES = 3
ACCURACY_REJECT_M      = 35      MIN_INTERVAL_S = 2
MAX_CREDIBLE_SPEED_KMH = 250     // سقف الخطوة الواحدة في الأميال (انظر أدناه)
MAX_NET_WINDOW_S       = 90      // نافذة النقاط اللي يُقاس منها صافي الإزاحة
MOVED_CIRCLE_FACTOR    = 2       // عدد الدوائر اللي الصافي لازم يعديها عشان يتحسب حركة
MIN_NET_SAMPLES        = 6       // تحتها النافذة تثبّت سيارة مش مشي
MIN_WINDOW_FIXES       = 2       // تحتها الإحداثيات مالهاش رأي خالص
MOVE_CONFIRM_S         = 15      // الواقف ما يسيبش «واقف» غير لما الحركة تفضل مدّة كده
MAX_ACCEL_MS2          = 6       // القفزة اللي محتاجة تمسك أكتر من كده مش سائق، دي موقع متنقل
STEPS_PER_MIN_ON_FOOT  = 12      // فوقها رجله على الأرض: «ماشي» وممنوع «راكب»
STILL_ENERGY_MS2       = 0.12    // تحتها مفيش حاجة لمّت الموبايل، مهما قال الريسيفر
IDLE_ALARM_MIN         = 30      // توقف > 30 دقيقة ⇒ STOP_EXCEEDED (override للسواق ← المنطقة ← العام)
STOP_REPEAT_MIN        = 5       // وهو لسه واقف: الصفحة بتتكرر كل 5 د (0 = صفحة واحدة) بمجموع مدة الوقوف
CONVERGENCE_WARMUP_S   = 60      // أول دقيقة من بدء التتبع مش أرض: الريسيفر لسه بيتظبط
```

`STOPPED` ≤1.5 · `WALKING` 1.5–7 · `RIDING` >7 · `UNKNOWN` (دقة سيئة/لا بيانات). نقطة التحول تُخزن في `MotionSegment` وتظهر للإدارة كـ «ماشي / في رحلة / واقف».

**أول دقيقة من بدء التتبع مش أرض (`CONVERGENCE_WARMUP_S=60`).** الريسيفر وهو بيفتح من الصفر بيطلّع حلول شكلها متماسك من جوّه — دقة معلنة وثيقة، ودوبلر معقول، وصفر خطوات — لكن أماكنه بترفرف: سواق واقف في بيته من لحظة بدء اليوم طلّع 58 ثانية نقاط بترفرف ~150 م حوالين مكان على بعد 950 م من مكانه الحقيقي، وكل الحرس عدّتها لأن الوهم ماتناقضش مع نفسه. فأول 60 ثانية من أول إصلاح في اليوم تتفحص وتتخزن ويريلبلي يقرأها، بس ما بتأسّسش مكان في الـ trace ولا خط ولا أميال ولا مرساة توقف. مُطبّقة في `TraceService.dropAndClean()` و`replayDay()` مع بعض، فالخط المخزّن (`RouteLine`) ومسار `/positions/route` و`/positions/trails` و`Trip.distanceKm` كلهم على نفس الحكم.

**الأميال لا تجمع قفزات الـ GPS ولا اهتزاز الموبايل الراكن.** أي مجموع مسافة (`/positions/route`،
`Trip.distanceKm`، `/positions/trails`، `RouteLine`، تقرير `mileage`/`route`) يمر عبر
`TraceService.stepMetres` → `GeoService.groundDistanceM`: الخطوة تُعدّ صفر كيلو متر لو السرعة اللازمة
لها تتجاوز `MAX_CREDIBLE_SPEED_KMH` (أو لو الزمن راجع/مكرّر) — ده نفس السقف اللي بيرفض بيه حارس
القفزة الشاذة العينةَ نفسها — وتُعدّ صفر كمان لو أقصر من **فقاعة الحركة بتاعة الخطوة**
(`MOVED_CIRCLE_FACTOR × noiseRadiusM` لدقة النصين). خطوة جوه الفقاعة المصنِّف برفضها كسرعة أصلًا،
فممنوع تُجمَّع مسافة: من غير ده يوم سواق «متوقف» من ساعة التشيك ان كان بيطلّع نص كم من رجّة الـ GPS
حوالين مكانه. بدونه نفق أو إعادة تثبيت إشارة أو نقل بين موقعين كان بيضيف عشرات الكيلومترات.

**الخط والمران بيخضعوا لنفس حكم الحالة.** سقف `MAX_CREDIBLE_SPEED_KMH=250` بيرفض القفزة المستحيلة
بس، ودي قفزة ممكنة تمامًا على الورق: سائق ركن من ساعة «بدء اليوم» وخطه طالع 7.7 كم راح وجا في
1.2–2.5 كم، والحالة بتقول «متوقف» صح. الأسباب دي نقاط شبح: الجهاز نام وبعت وهو صاحي آخر موقع
محفوظ من نص المدينة، تاني نقطته ترجع بالظبط لمكانه. فالمسار بيردّ السؤال بتاع §5 نفسه — **هل
الطريق اتسُجل؟**:
- مجموعة نقاط بتخرج عن نطاق الـ drift (`accuracyDriftM=120` م) و**ترجع** ليه، وفوج من فوجائها
  صمت أطول من `MAX_NET_WINDOW_S=90` ثانية (يعني مافيش نافذة شهدت خروجه أو رجوعه) ⇒ أرضية مش
  مسجولة: النقط دي بتفضل في اليوم بس `credible: false`، وبتخرج من الخط ومن `distanceKm` ومن
  علامات التوقف مع بعض.
- **الفرق عن النقل الحقيقي**: نقل = اتحرك وقعد في مكانه الجديد (ده بيبقى خط وسفر)، وروحة ورجوع
  بيغطيهم الجهاز بعيناتهم كل 15–60 ثانية = رحلة حقيقية وبتفضل كاملة. ومجموعة أكتر من
  `MAX_UNSEEN_RUN_FIXES=6` نقاط بعيدة ما تتحكمش فيها خالص — دي رحلة مش ومضة.
- **مصدر واحد للخط**: `GET /positions/route`، `/positions/trails`، `RouteLine.geojson` المخزّن،
  و`Trip.distanceKm` عند قفل الرحلة، وتقرير `/reports/route` — كلهم بيمروا على
  `TraceService.groundTrace()` (في `common/geo/trace.service.ts`)، فمستحيل واحد منهم يخالف التاني
  أو يخالف الحالة.
- **حدّ القاعدة**: مفيش دليل على الطريق = مفيش خط. لو السواق سافر فعلًا والجهاز نام الرحلة دي
  وكل شوية، الخط هيبان مقطوع وهيحصل على مسافة أقل من الحقيقة. ده مقصود: المرسوم لازم يكون أرض
  اتسجلت، مش مسافة مخمّنة.

**الوقوف نقطة، مش خطوط.** بعد ما تتشال النقاط اللي مش أرضية، بيفضل تسكّع الجهاز على الترابيزة:
50 قراءة في الساعة بتتلعب 20–50 متر حوالين نفس الرجل، ومرسومة قراءة-بقراءة بتطلع نجمة من الخطوط
وفولها «0.11 كم خط سير» تحت شارة «متوقف». فقاعدة `TraceService.collapseStays()` بتطبق حساب §5
نفسه على كل مجموعة نقاط متتالية:
- المجموعة بتعتبر **موضع وقوف واحد** لو كل قراءاتها جوه نطاق الـ drift من متوسطها (`accuracyDriftM`)
  **و** صافي الإزاحة بين متوسط نصها القديم ومتوسط نصها الحديث ما عداش الفقاعة
  (`MOVED_CIRCLE_FACTOR × noiseRadius × √2 ÷ √n`) ولا اللي كان ممكن يقطعه سكون كامل في نفس المدة.
- المجموعة دي بتنزل في الخط **بنقطة واحدة** في وسطها (نقطة وقوفه) — ف`distanceKm` بيبقى صفر،
  والـ geojson نقطة واحدة، والداشبورد بيرسم دائرة وقوف مش بوليجون. و`groundedStops()` بين نفس
  النقطة: كل توقف بيسندوه الخط بيلتقط عندها، فسبعة توقفات حوالين رجل واقفة بيبقوا سبع دايرات على
  مكانه هو، مش مروحة حوله.
- المشي الحقيقي بيكسر المجموعة من أول چند خطوات (صافيه يعدّي الفقاعة) فخطه بيرسم ويبان، و`/positions/route`
  بيوصلّي `trace: [{lat,lng,clientTs,motionState}]` — المواقع اللي الأرض بتسند بينها — والداشبورد
  بيرسم منها مش من القراءات الخام. السوكت بضيف ذيله على الخط بس لما يبعد 60 متر عن آخر نقطة مرسومة.
- **الحدّ**: ساعة وقوف فيها مشي ذهاب وعودة قصير (جوه الـ 120 م) بتتحسب نقطة وقوف واحدة؛ ده مقصود
  — النطاق ده بالضبط هو اللي العقد بيقول إن الإحداثيات جوهه ما تفرّقش.

**الأرض هي اللي بتحكم — صافي الإزاحة، مش نقطة لنقطة.** `MotionClassifierService.groundSpeed`
(السيرفر) و `MotionClassifier._groundSpeed` (الموبايل) نفس الحساب حرفيًا، وأي اختلاف بينهم بيظهر
سريعًا على شكل «الموبايل قال ماشي والداشبورد قال واقف»:
- الحركة تُقاس من **صافي إزاحة نافذة**: متوسط النصف القديم من آخر `MAX_NET_WINDOW_S=90` ثانية من
  النقاط إلى متوسط نصفها الحديث. تسكّع الـ GPS ضجيج متوسطه صفر فبييُلغى جوه المتوسط، بينما الراجل
  بيترجم النافذة كلها معاه. القياس من نقطتين (الـ anchor القديم) قرأ تذبذب موبايل واقف 40 م راح
  وجا كـ 6 كم/س، وقال «ماشي» لراكن في الفسحة.
- `noiseRadiusM = min(max(accuracy, 12), accuracyDriftM)`، و**الفقاعة** حوالين متوسط النصفين:
  `MOVED_CIRCLE_FACTOR × noiseRadiusM × √2 ÷ √n` — المتوسط بتاع n نقطة بيقلّل الضجيج بجذره.
- بيعدى خارج فقاعته لما الصافي يعدي الفقاعة **و** اللي نطاق «واقف» نفسه يقطعه في نفس المدة. جوه
  الفقاعة سرعته اللي فاضل بعد ما تتطرح الفقاعة — يعني صفر.
- نافذة فيها أقل من `MIN_NET_SAMPLES=6` نقاط ما تثبّتـش مشي (انفجار drift 3 كم/س ومشي 3 كم/س نفس
  الرقم عند نقطتين تلاتة)، بس تقدر تثبّت عربية: صافي فوق `WALK_MAX_KMH`.
- مباعديش فقاعته ⇒ «واقف» **حقيقة مش تقدير** بتتثبت على طول بدون الـ 3 samples بتاعة الـ
  hysteresis (`confirmStationary`). ونقطة واحدة مش نافذة: الموبايل بيحكم عليها من قراءته هو.
- الموبايل يرفع **السرعة اللي هو حكم بيها** (`lastRawSpeedKmh`)، مش الـ Doppler ولا خطوة الشيرد،
  عشان السيرفر يقرا نفس الرقم اللي اتبني عليه حالته.
- **الحد الصريح**: الإحداثيات بتفرّق الراكن عن الماشي، ومش بتفرّق الماشي عن المتجوّل في مكانه —
  119 م راح وجا في 10 دقايق صافيها 7.5 م بتقرا «واقف» عن قصد. إثبات الخطوات نفسه مستشعر، وده بقى
  موصّل: الموبايل بيقرا `stepsPerMin` و`motionEnergy` من الـ accelerometer ويلحقهم بكل نقطة.

**المستشعر موصّل من الطرفين (`apps/mobile/lib/services/motion_sensor.dart`).** نافذة 10 ثواني من
`|a|` بعينة كل 100 مili ثانية (`sensors_plus` — الـ accelerometer مالوش permission، فمفيش منحنى
صلاحية جديد على الموبايل):
- `motionEnergy` = الانحراف المعياري جوه النافذة بوحدة m/s². موبايل راكن على ترابيزة ≈ 0.02،
  و`STILL_ENERGY_MS2=0.12` بيرجّع الحالة للسكون تحت الرقم ده مهما قال الريسيفر.
- `stepsPerMin` = عدد العبور لأعلى فوق متوسّط النافذة (مش عدد القمم: إشارة المشي نفسها بتولّع أكتر
  من قمة في الخطوة)، بحدّ أدنى 300 مili ثانية بين خطوتين، و**بس** لو السعة (peak−min)عدّت 0.7 m/s²
  ولو الإيقاع بقى مشي فعلاً: كل فاصل بين خطوتين في نطاق 330–1500 مili ثانية وأكتر بعد عن المتوسط
  ما يعديش 50% منه. الحفر على الطريق نبضات متفرّقة فبتقرا صفر — لو اتقرا كـ خطوات كان سواق العربية
  اتصفّر على سقف المشي.
- الموبايل بيحكم بنفس أربع قواعد السيرفر بالظبط (`test/motion_classifier_test.dart` بيقفل عليهم):
  `STEPS_PER_MIN_ON_FOOT` بيسقفه عند `WALK_MAX_KMH`، و`STILL_ENERGY_MS2` بترجّعه «واقف»، و
  `MOVE_CONFIRM_S=15` ما يسيبش «واقف» غير لما الحركة تفضل 15 ثانية على نافذة لسه ما نضجتش، و
  `MAX_ACCEL_MS2=6` بيرفض القفزة اللي مفيش جسم بيمشيها. ثوابت المرآة اتزودت للـ 15 مفتاح و
  `test/constants_golden_test.dart` بيقارن بالـ golden.
- **الشهادة بتتخزن مع النقطة** (`Position.stepsPerMin` / `Position.motionEnergy`)، و`replayDay`
  بيقرأها: الرحلة ونقاط خط السير والآثار كلها بتستنتج اليوم بنفس الأرض اللي قالت «واقف» وقت ما
  النقطة وصلت. من غير التخزين ده الـ replay كان بيرسم اليوم من الإحداثيات لوحدها — نفس الدفعة
  اللي الموبايل حكم عليها سكون ترجع «راكب 120 كم/س» أول ما حد يفتح خط السير.
  `sensor-witness.spec.ts` بيقفل على الوجهين: بـ شاهد سكون وبلا شاهد رحلة.

**حكم الخط بيتقدّم على حكم النافذة، ورجله بتقدّم عليه.** نفس الحساب اللي بيرسم بيه الخط اليوم
(`TraceService.stayedPut`) بيسألّه المُحكِّم على كل نقطة — `PositionsService.stayOf` في السيرفر
و`MotionClassifier._stayOf` في الموبايل — والمجموعة اللي الخط رايح ينزّلها نقطة واحدة **ممنوع**
تتقراها رحلة:
- الـ veto يقع **لما المجموعة تكبر عن نافذة الدليل** (`MAX_NET_WINDOW_S=90` ثانية من أول نقطة فيها).
  مجموعة أصغر من كده هي بنفسها دليل النافذة: نفس النقاط، فرفضها بيضيف تأخير بس على مشي بيبدأ من
  سكون. ونقطة واحدة مش موضع وقوف خالص — الفيتو محتاج المكان يتشاف مرتين قبل ما يغلّب النافذة.
- الفيتو بيسأل `stayedPut` بسقف تيه `wanderCapS=90`: مفيش قاعدة في §5 بتتقاس على أكتر من نافذة
  دليل، ومجموعة شهدت 90 ثانية سفر حقيقي مش مجموعة يُقال لها اقعد. الخط نفسه بيسأل بلا سقف —
  موبايل نام ساعة وبعت موضعه كل دقايق ده لسه موضع وقوف واحد في الرسم.
- الشاهد اللي بيغلبه: `stepsPerMin ≥ STEPS_PER_MIN_ON_FOOT`. موبايل بيعدّ خطوات وترصّه ثابت = راجل
  يمشي في أوضة، ومفيش مجموعة نقط جوه نطاق drift واحد بيفرّق ده عن الوقوف. يوم الموبايل المثبت
  (22 نقطة حوالين فقاعة 35 م، صفر كم مرسوم، والريسيفر بعت 57.9 كم/س) بيقفل عليه
  `mounted-phone.spec.ts` (السيرفر) و`motion_classifier_test.dart` (الموبايل) — **جدول الحكم نفسه
  سطر بسطر على الطرفين**، بشاهد وبلا شاهد.
- الرحلة = نفس الادعاء بعد ثمنه: الرحلة ما تتفتحش غير لما الحركة تفضل `MOVE_CONFIRM_S=15` ثانية
  (`moveRunSinceTs`)، زي ما الحالة ما تسيبش «واقفش» غير لما تفضل مدّتها — نافذة صدّفت فقاعتها
  بالصدفة هي نفسها نقطتين من رجّة موبايل راكن.
- **الشارة الحية بتتآكل**: جهاز أونلاين سكتت نقاطه أكتر من نافذتين (`2 × MAX_NET_WINDOW_S`) ونهاره
  لسه مفتوح ⇒ الحالة بتتعرض «متوقف» والسرعة صفر. الحالة الحية وصف للحظة دي، مش صدى آخر نقطة:
  «المرة اللي اتغيرت فيها لرحلة ما رجعتش سكون تاني» كانت القراءة بتفضل عالقة لآخر اليوم.
- الأرض اللي تصدّقها السيرفر بتتخزن في `Position.groundKmh`، والقراءة الحية بتعرضها هي — مش الـ
  Doppler الخام. من غير ده الداشبورد بيشوف رقم مختلف عن اللي اتبني عليه قرار الحالة.

**الإمداد رجع لمصدر أندرويد الافتراضي (fused) بقرار المشغّل 2026-10-27.** تجربة «الـ GNSS لوحده»
طلعت بثمنها: جوّه مبنى من غير لوك القمر سكوت سكوت، واللوح الحي (اللي بيتبنى من النقط) رسم إن السواق
مش موجود خالص رغم إنه متصل ويومه مفتوح وصفر تنبيهات. فالخط تاني بياخد ردّ الـ fused — من بصمة
الـ Wi-Fi/RF ومن الكاش، نفس المصدر اللي كان بيعمل شبح 509 م/137 كم/س بعد الـ doze — والحرس بقى كله
downstream: فلاتر الطيف المستحيل، شاهد المستشعر (`motionEnergy`)، وبوابة «أحدث من اللي قبلها» في
محرك التتبع. الصفقة المعتمدة: تدفّق جوّه مبنى، مقابل خط ما بيسنّدش غير اللي الفلاتر سمحت بيه.

`currentFix()` (زرّ بدء/إنهاء اليوم) بتبدأ بالكاش: آخر موقع مخزّن لو عمره تحت 45 ثانية ودقته مش
تقريبية Wi-Fi بيرجع فورًا — زرار ما يحملّش نص دقيقة وهو جوّا. لو الكاش قديم محاولة موقع واحدة
(مهلة `freshFix` الـ 12 ثانية) وبعدها الكاش مهما كان عمره. الحرس اللي بيطردها من خط السير هو إن
النقطة في محرك التتبع لازم تكون أحدث من اللي قبلها — الكاش ده للنقطة الإدارية بس، مش للخط.

**الرحلة تُقفل على الأرض، مش على كلام الجهاز.** `Trip.startedAt/endedAt/distanceKm/maxSpeedKmh` كلّه
من نفس القراءة اللي بترسم الخط (`PositionsService.finalizeTrip` → `replayDay` → `collapseStays`):
- الرحلة بتتحسب من آخر `TRIP_ANCHOR_LOOKBACK_MS=6 ساعات` قبلها، مش من نافذتها هي — اختبار
  «روحة ورجوع» محتاج النقطة اللي **قبل** ما الجهاز يصحى. لو اتقفلت على نافذة الرحلة لوحدها الشبح
  بيبقى هو الـ anchor: يوم D0203 خط اليوم رفض دفعة الـ 137 كم/س والرحلة وهي بتجمّعها (1.434 بدل 1.01).
- الرحلة بتبدأ من أول نقطة بيسندها الخط: اتفتحت 18:52 على قفزة مرفوضة، و`startedAt` بقى 19:21 —
  أول خطوة حقيقية فعلًا.
- سرعته القصوى من النقط اللي الخط بيسندها، وخطوة تُعدّ بس لو الأرض مشيت بيها فعلًا (`stepMetres > 0`):
  القراءة اللي اتطبقت في موضع وقوف **مفيش ليها سرعة**. من غير القفل ده يوم مشي كامل قفل بـ 24.8 كم/س
  على 165 متر شالهم الجهاز وهو بييعيد تثبيت الإشارة.
- لو كل نقاط الرحلة مرفوضة (مفيش خط خالص) بيتساب counter المجمع زي ما هو — مفيش أرض تُحاسب عليها.
- **الحدّ اللي بيفضل**: دفعة نقاط صحّها الداخلي معقول (100 م في 3 ثواني وDoppler بيقول 99 كم/س)
  الإحداثيات مالهاش سبب ترفضها — 16 نقطة كده من أصل 249 في يوم D0203. دي بقى ليها شاهد تاني:
  `motionEnergy` بتاعة المستشعر بترجّعها «واقف» لو الجهاز ما اتلمسش، والمرآة في الموبايل بتعمل نفس
  الحساب قبل ما تبعت. **المقابل**: عربية ماشية على إسفلت ناعم وموبايل ثابت في حامل ممكن يقرأ تحت
  `0.12` فيقول «واقف» — ده سعر الشبح، ولو ظهر على الطريق بيتعالج برفع `STILL_ENERGY_MS2`.

**الوقفة بتتقفل على الأرض كمان.** الوقفة اللي فضلت مفتوحة لحد ما الرحلة اتقفلت (`endDanglingStops`)
مالهاش دعوة بساعة الرحلة: `endedAt` بتاعة الرحلة هو آخر لحظة الأرض **حرّكته** فيها — ودي قبل ما
يركن أصلاً. اقفال الوقفة بده كان بيرسم لوحة وقفة خلصت قبل ما تبدأ (startTs 21:02:10/endTs 21:01:19
مقاس لايف)، ووقفة تانية خلصت قبل ساعة الرحلة اللي اتنصفت وهي شغّالة. القاعدة:
- الوقفة بتقفل على **آخر نقطة اليوم شافه فيها واقفًا في مكانها**، بشرط إن صمتها عن آخر نقطة ما
  عدّاش `TRIP_IDLE_MS=10 دقايق` — عشان وقفة ما توصلش لشيفت تاني.
- ومفيش إقفال قبل لحظة الفتح أبدًا: تشيك اوت بخادم ساعته ورا ساعة الموبايل، أو رحلة قفلت على
  `lastMoveTs`، الاتنين بيرجعوا لنفس الأرض. `durationS` بتتحسب من فتح الوقفة نفسها، مش من فتح الرحلة.

**`HYSTERESIS_SAMPLES` بيعد العينات اللي بتعاند الحالة المثبتة** — مش العينات المتطابقة مع بعضها.
تقدير السواق الراجل بيقفز (3.4 → 18 → 8.3 → 4.7 → 9.1 → 8.2 كم/س) لأن خطوات الـ GPS بتقع على
ناحيتين لخط الـ 7، فاشتراط 3 عينات من نفس الـ band **الجديد** كان بيخلّي المرشّح يصفّر نفسه كل
مرة والرجل ما يسيبش «واقف» أبدًا — حتى وهو مشي مسجَّل في خط السير.

## 6. Rules engine → Alerts

كل تنبيه له `type` من القائمة في README + `severity`: `INFO` · `WARNING` · `CRITICAL`.

| النوع | الشرط الافتراضي | severity | audience |
|---|---|---|---|
| `GEOFENCE_EXIT` | خارج `Zone` لأكثر من `geofenceGraceS=120` | CRITICAL | السواق + المشرفون |
| `SPEEDING` | `speed > maxSpeedKmh` لمدة 3 عينات | WARNING→CRITICAL بعد `speedingCriticalS=120` | السواق + المشرفون |
| `HARSH_BRAKING` | دسليرة ≤ `-2.2 m/s²` | WARNING | المشرفون + السواق |
| `HARSH_ACCELERATION` | ≤ `2.2 m/s²`… (تسارع > `2.8 m/s²`) | INFO | المشرفون |
| `STOP_EXCEEDED` | `STOPPED` > `stopAlertMin` (override للسواق ← المنطقة ← العام = 30 د) — ووهو لسه واقف بتتكرر كل `stopRepeatMin=5` د (0 = بلا تكرار) ونص التكرار بيقول مجموع مدة الوقوف من أوله («ما زال متوقفًا منذ 7 دقيقة») | CRITICAL | المشرفون + السواق |
| `GPS_OFF` / `DATA_OFF` / `APP_OFFLINE` | حدث من الجهاز أو فوات قلب ≥ 3 فترات — **للسواق اللي يومه مفتوح بس** (سجل حضور بلا انصراف لنفس `workDate`)؛ جهاز مسجّل وما بدءش يومه ما ينفعش يكون «متقطع». وميتمش رفع «غير متصل» لحظة وصول نبض: وصول النبض دليل الاتصال، والصمت اللي أثناء اليوم يشيله الـ heartbeat sweep | CRITICAL | المشرفون + السواق |
| `BUFFER_REPLAYED` | وصول دفعة `buffered=true` | INFO | المشرفون |
| `CHECK_IN_OUT_OF_FENCE` | انطباق فاشل | WARNING | الطرفين |
| `ROUTE_GAP` | فجوة > `gapMinMin=10` د أثناء الرحلة | WARNING | المشرفون |
| `HELP_REQUESTED` | ضغطة مطوّلة **٣ ثوانٍ متصلة** على دائرة «طلب مساعدة طارئة» في موبايل السواق (`POST /devices/help`) — لا تُرفع تلقائيًا من السيرفر أبدًا | CRITICAL | المشرفون (والسواق يرى طلبه لأنه في `DRIVER_VISIBLE_ALERTS`) |

خصائص قابلة للتعديل لكل `Zone`/سواق عبر `RuleOverride`؛ الأولوية: override للسواق ← override للمنطقة ← الافتراضي في `.env`.
**Cooldown/De-dupe:** نفس `(userId, type)` لا يتكرر قبل `cooldownS` (افتراضي 180) ما لم تتصاعد الخطورة.
كل alert يطابق `AlertPayload` المُعرَّف في `apps/api/src/modules/notify/alert-dispatch.service.ts`:

```ts
{ id, type, severity, userId: string | null, employeeId, userName, phone, orgUnitId,
  zoneId: string | null, siteId: string | null, title, body,
  createdAt, status: "OPEN"|"ACK"|"RESOLVED", ackBy?, ackAt?, replayed: boolean,
  meta: { lat, lng, speedKmh?, stopDurationS?, threshold?, offlineSince?, bufferCount?, ... },
  // الحَمولة الأساسية (socket alert:new): channel { push, socket }
  channel: { push: boolean, socket: boolean } }
```

مسار التنبيهات:
- `GET /alerts?status&type&severity&userId&zoneId|zone&from&to&page&pageSize` (قراءة `ADMIN`+`SUPERVISOR`، مع تضييق المشرف على شجرته التنظيمية) → **مغلّف `{ alerts, data, meta }`** حيث `alerts` و`data` نفس المصفوفة (`data` مُبقاة للتوافق مع سكربت e2e)، و`meta = { total, page, pageSize }`. كل عنصر هنا يُضاف إلى `channel` حقل **`whatsapp`**: `"SENT"|"PENDING"|"FAILED"|"NO_PROVIDER"|null` (من صفوف `NotificationLog(channel=WHATSAPP)`، ولا يُختلق "SENT" أبدًا — غياب الصف ⇒ `null`).
- `GET /alerts/me` (الموظف/السواق — تنبيهاته الشخصية فقط؛ السواق يرى أنواع `DRIVER_VISIBLE_ALERTS` حصرًا) → **مصفوفة مجردة** `AlertPayload[]`.
- `GET /alerts/:id` → `AlertPayload & { callLogs: [] }`. `GET /alerts/stream/summary` → `{ total, open, byType, bySeverity, byStatus }`.
- `POST /alerts/:id/ack` → `{ ok, id, status:"ACK" }`، `POST /alerts/:id/resolve` `{ note }` → `{ ok, id, status:"RESOLVED" }`، `POST /alerts/:id/call-log` `{ called: boolean, note }` (وتسجيل مَن اتصل بالسواق ومتى: `at`).

## 7. Realtime (Socket.IO, namespace `/rt`)

`connect` مع `auth: { token }` (نفس سر `JWT_SECRET` كطبقة HTTP) → ينضمّ الـ socket إلى غرف: `role:<ROLE>`، `watch:admins` (لـ `ADMIN`+`SUPERVISOR` فقط)، و`user:<id>` (دائمًا، بمعرّف تسجيل الدخول). يصل `rt:ready { userId, role }` عند النجاح، أو `rt:error { code:"NO_TOKEN"|"BAD_TOKEN" }` ثم قطع.

| Event | الاتجاه | الحمولة |
|---|---|---|
| `position:update` | → إداريين + صاحب النقطة | **`LivePosition` الكامل** (انظر `apps/api/src/common/contracts.ts`) |
| `alert:new` | → الكل المعني | `AlertPayload` كامل |
| `alert:updated` | → إداريين | `{ id, status, ackBy, ackAt }` |
| `attendance:changed` | → إداريين | `{ userId, kind, status, ts }` |
| `driver:presence` | → إداريين | `{ userId, online, tracking, gpsEnabled, lastSeen }` |
| `notify:me` | → السواق/الموظف | `{ title, body, alertType }` (تنبيه الشخص لنفسه) |
| `subscribe:live` / `subscribe:route` | ← العميل | `{ userIds?: [] }` → ينضم لـ `watch:live:<id>` / `watch:route:<id>` ويردّ `{ ok:true, rooms:[...] }`. **التفويض على الغرف:** `ADMIN`+`SUPERVISOR` يشتركان في أي معرّف؛ وأي دور تاني (`HR`/`EMPLOYEE`/`DRIVER`) تُفلتر طلباته لمعرّفه هو فقط (`user.id` أو `employeeId`)، فالباقٍ يُسقط من `rooms` — لا يوجد بث موقع يتجاوز حراسة الأدوار. |

**مخطط غرف `position:update` (Gateway `socket-gateway.ts`):** لكل نقطة يُوجَّ `position:update` إلى `[watch:admins, watch:live:<userId>, user:<userId>]` — وحيث `userId === employeeId` (مفتاح الداش بورد الحيّ). وبما أن `LivePosition.authUserId` (معرّف تسجيل الدخول خلف الموظف، `string | null`) قد يختلف عن `employeeId`، يضيف الـ gateway غرفتين إضافيتين عند وجوده: **`user:<authUserId>`** و**`watch:live:<authUserId>`** — حتى يرى التطبيق موقعه بنفسه رغم اختلاف المعرّفين.

حمولة `position:update` = `LivePosition` المُوسَّع:
```json
{ "id": "emp_1", "userId": "emp_1", "employeeId": "emp_1", "name": "محمد", "userName": "محمد",
  "externalId": "E100", "kind": "DRIVER", "driver": true, "lat": 30.0444, "lng": 31.2357,
  "speedKmh": 42.5, "motionState": "RIDING", "insideZone": true, "ts": "2026-10-22T06:31:04.000Z",
  "replayed": false, "accuracy": 8, "battery": 81, "zoneId": "z1", "zoneName": "القاهرة",
  "siteId": null, "siteName": null, "authUserId": "usr_9", "online": true, "tracking": true,
  "gpsEnabled": true, "dataEnabled": true, "lastSeen": "2026-10-22T06:31:05.000Z" }
```
`dataEnabled` لا يعمود له في المخطط — يُشتق من `online` (انظر §14).

Push (FCM/APNs) يطابق نفس الحدث ويوصل والتطبيق مقفول؛ أي حدث لا يصل له push يُعتبر خللًا ويُصفَّف في `notification_log` بحالة `FAILED` مع retry (3 مرات، backoff).

## 8. Employee sync (الداتا بيز الرئيسية)

 adapters: `sql` (توصيل مباشر) · `rest` (JSON endpoint) · `csv` (رفع ملف). كل adapter يخرّج نفس الصف:

```ts
{ externalId: string, name: string, phoneE164: string, roleHint?: "EMPLOYEE"|"DRIVER",
  orgUnit?: string, siteCode?: string, zoneCode?: string, active?: boolean }
```

- المفتوح عليه: `externalId` (معرّف الموظف في الداتا الرئيسية) — upsert idempotent: إدراج الجديد وتحديث المتغيّر فقط، **لا تكرار أبداً**، و**المزامنة لا تحذف موظفًا إطلاقًا**: الاختفاء من المصدر = **تعطيل** (`active=false` عبر `deactivateMissing` مع issue `DEACTIVATED`) لا حذف، وسجلاته (attendance/positions/alerts) تبقى سليمة. النطاق محصور في صفوف `source=MASTER` التي رآها نفس المصدر سابقًا (seen-set في `Setting key='sync:seen:<sourceId>'`) حتى لا يعطّل مصدرٌ صفوفَ مصدر آخر.
- لا يُنشأ حساب بدون `phone` صحيح (إلزامي لواتساب/اتصال الطوارئ)؛ النقص يذهب لـ `SyncIssue` (`MISSING_PHONE`) بدل الفشل الصامت. كذلك `DUPLICATE`/`BAD_ROLE`/`UNKNOWN_SITE`/`UNKNOWN_ZONE`/`IDENTIFIER_COLLISION`/`NO_INIT_PASSWORD`.
- **أسرار المصادر لا تغادر الـ API أبدًا**: كل قراءات `config` تمرّ بـ `maskConfig` — `token/secret/password/apiKey/accessPoint` تُستبدل بـ `****`، وكلمة المرور المدمجة في `connectionString` تُخفَى، و`webhookSecret` لا تُعاد نصًا صريحًا (تحلّ محلها `hasSecret` + `webhookSecret:"••••••••"` عند وجودها). في `GET /sync/runs/:id` يُحذف حقل `config` من المصدر المُرفَق. عند `PATCH` بجسم مُخفَى تُحفَظ الأسرار الحية القديمة.
- المشغلات: `POST /sync/runs` (يدوي، `202` → `{ runId, status, skippedOverlap? }`)، مجدول بـ `SYNC_CRON` (افتراضي كل 15 د) + trigger عند أي تغيير عبر webhook عام `POST /sync/webhook?source=<id>` (header `x-sync-secret`، مقارنة timing-safe). تداخل تشغيل `RUNNING` بنفس المصدر ⇒ `SKIPPED_OVERLAP`.
- **قراءات اللوحة — كلُها مغلّفة** (وليست مصفوفة مجرّدة):
  - `GET /sync/sources` → `{ sources: [...] }` (كل مصدر يحمل `id, code, name, kind, config(مُخفَى), scheduleCron, enabled, lastRunAt, hasSecret, webhookSecret`)؛ `GET /sync/sources/:id` → جسم المصدر المفرد (بلا مغلّف).
  - `GET /sync/runs?limit=1..200` (افتراضي 50) → `{ runs: [...] }`، وكل run يحمل `id, sourceId, sourceName, triggeredBy(=trigger: MANUAL|CRON|WEBHOOK), startedAt, finishedAt, status, scanned, created, updated, unchanged, deactivated, error`.
  - `GET /sync/issues?resolved=` → `{ issues: [...] }`، وكل issue يحمل `id, runId, externalId, code(=reason), reason, name, detail, resolved, createdAt`. لا يعمود `name`/`createdAt` في `SyncIssue` — `name` يُستقصى من صف الموظف بنفس `externalId`، و`createdAt` = `startedAt` للتشغيل المالك (انظر §14).
  - `GET /sync/matrix` → `{ rows: [...] }` (لوحة الطزاجة: `source, field, lastSyncAt, freshnessMin, rows`).
  - `GET /sync/runs/:id` → `{ run, source, counts, issues }` حيث `counts = { scanned, created, updated, unchanged, deactivated, noPhone, issues }`.
- الربط بالمستخدم: `User.employeeId`؛ المستخدم الجديد ياخد كلمة مرور مؤقتة `mustChangePassword=true` واسمه معرّفه بالـ externalId.

## 9. Reports

كل دوال `ReportsService` تُرجع كائنًا داخليًا `ReportResult = { headers: string[], rows: Cell[][], body }` — `headers/rows` خلايا CSV عربية-آمنة، و`body` هو مغّلّف JSON الذي تعرضه صفحات الداش بورد. **على حدود HTTP**: الوضع الافتراضي يُرسل `body` فقط (`res.json(result.body)`) وليس `ReportResult` كاملًا؛ ومع `?format=csv` يُرسل **نص CSV خام** (`text/csv`) المبني من `headers/rows`. كل تقرير يفصل صراحةً بيانات معاد بثها (`replayed`) عن اللحظية. القراءات لـ `ADMIN`+`SUPERVISOR`.

| المسار | مغلّف JSON (`body`) |
|---|---|
| `GET /reports/daily?date` | `{ date, kpis, alertsByType, hourlyPositions }` |
| `GET /reports/mileage?from&to&groupBy=driver\|zone` | `{ groupBy, from, to, rows[], totalKm }` |
| `GET /reports/exceptions?from&to` | `{ rows[], grouped{}, total, unresolved, meta }` |
| `GET /reports/timesheet?from&to&userId` | `{ rows[] }` |
| `GET /reports/route?userId&date` | `{ userId, employeeId, date, stops[], meta }` |
| `GET /reports/live-kpis` | `{ activeDrivers, openAlerts, criticalAlerts, offlineDrivers, avgSpeedToday, generatedAt }` (بلا `?format`) |

أمثلة دقيقة:

`daily` — `kpis = { present, absent, activeDrivers, openAlerts, criticalAlerts, kmDriven, exceptions, offlineMinutes }`، `alertsByType = [{ type, count, open }]` (مرتّبة تنازليًا بـ count)، `hourlyPositions = [{ hour, count }]` (0–23 بحسب `DASHBOARD_TIMEZONE`):
```json
{ "date": "2026-10-22",
  "kpis": { "present": 41, "absent": 9, "activeDrivers": 18, "openAlerts": 3,
            "criticalAlerts": 1, "kmDriven": 612.4, "exceptions": 5, "offlineMinutes": 88.5 },
  "alertsByType": [{ "type": "SPEEDING", "count": 7, "open": 2 }],
  "hourlyPositions": [{ "hour": 8, "count": 120 }] }
```

`mileage` — `rows = [{ key, label, km, ridingMin, replayedKm }]` مرتّبة تنازليًا بـ `km`، مع `totalKm` كلي:
```json
{ "groupBy": "driver", "from": "2026-10-01", "to": "2026-10-22",
  "rows": [{ "key": "emp_1", "label": "محمد", "km": 120.5, "ridingMin": 210.3, "replayedKm": 14.2 }],
  "totalKm": 120.5 }
```

`exceptions` — `rows = [{ type, count, unresolved }]` (تجميع لكل نوع، `unresolved = OPEN|ACK`)، و`grouped = { <type>: count }`، و`total`/`unresolved` كليّان، و`meta.open` = عدد التنبيهات المفتوحة المعروضة في قائمة التفاصيل:
```json
{ "rows": [{ "type": "GEOFENCE_EXIT", "count": 4, "unresolved": 1 }],
  "grouped": { "GEOFENCE_EXIT": 4 }, "total": 4, "unresolved": 1, "meta": { "open": 4 } }
```

`timesheet` — `rows = [{ userId, userName, date, checkIn, checkOut, hoursWorked, status, replayed }]` (`checkIn/checkOut` ISO أو `null`، `hoursWorked` من الفرق، `replayed` مشتق من نقاط `buffered/stale`).

`route` — `stops = [{ startedAt, endedAt, durationS, kind, lat, lng }]`، و`meta = { distanceKm, pointCount, replayed }`.

(نسخة الـ CSV لكل المسارات أعلاه تُبني من `headers/rows` وتُرسل كنص خام.)

## 10. متغيرات البيئة (`.env`)

`DATABASE_URL` · `JWT_SECRET` · `JWT_REFRESH_SECRET` · `PORT=3000` · `SYNC_CRON` · `REPLAY_MAX_AGE_HOURS=72` ·
`DEFAULT_MAX_SPEED_KMH=80` · `STOP_ALERT_MIN=30` · `GEOFENCE_GRACE_S=120` · `HEARTBEAT_INTERVAL_S=300` ·
`FCM_PROJECT_ID/FCM_CREDENTIALS_JSON` · `WACLOUD_TOKEN/WACLOUD_PHONE_NUMBER_ID` (اختياري) · `ADMIN_INIT_PASSWORD`.

## 11. Employees (الموظفون)

القراءات لـ `ADMIN` + **`SUPERVISOR`**؛ الكتابات لـ `ADMIN` فقط (`EmployeesController`، مع تضييق المشرف بحسب نطاقه حيث يُطبَّق).

| Method | Path | الوصف |
|---|---|---|
| GET | `/employees?page&pageSize&search&kind\|role&siteId&zoneId&active` | → **`{ employees, total, page, pageSize }`**. `?role=` اسم مرادف لـ `?kind=` (الداش بورد يرسل `role=DRIVER`). |
| GET | `/employees/live?kind&siteId&zoneId` | مصفوفة مجردة من حالة الحضور/التتبع اللحظية لكل موظف نشِط. |
| GET | `/employees/:id` | صف الموظف + `site/zone/user` + الحقول المشتقة أدناه + `maxSpeedKmh`/`stopAlertMin` الفعّالان + `live`. |
| GET | `/employees/:id/devices` | → `{ devices: [...] }` (توكن الـ push مُخفَّى). |
| GET | `/employees/:id/summary` | → `{ motionMinutes:{stopped,walking,riding}, openAlerts, totalAlerts }` (دقائق اليوم بحسب حالة الحركة، مع سقف فجوة 5 د). |
| GET | `/employees/:id/rules` | صف `RuleOverride` أو `null`. |
| POST | `/employees` | إنشاء (+ توليد حساب دخول بكلمة مرور مؤقتة `mustChangePassword=true`). |
| PATCH | `/employees/:id` | تعديل الملف الوظيفي. |
| POST | `/employees/:id/assign-site` `{ siteId? }` · `/assign-zone` `{ zoneId? }` | تعيين/فك (`200`). |
| PATCH | `/employees/:id/rules` | `RuleOverrideDto` — يقبل **`zoneId`** فيعيد تعيين منطقة الموظف في نفس الاستدعاء، ويرد `{ employeeId, zoneId, maxSpeedKmh, stopAlertMin }` الفعّالة. |
| POST | `/employees/:id/disable` · `/enable` | تعطيل/تفعيل (`active=false/true`؛ لا حذف). |

كل صف في `employees[]` يضيف فوق أعمدة Employee (`id, externalId, name, phone, email, jobTitle, kind, active, source, orgUnitId, siteId, zoneId, createdAt, updatedAt`) الحقول المشتقة: **`identifier`(= `externalId`)، `role`(= `kind`)، `driver`(bool)، `zoneName`، `siteName`، `live`**. `live` = آخر `LivePosition` للموظف خلال 24 ساعة أو `null`:
```json
{ "employees": [
  { "id": "emp_1", "externalId": "E100", "identifier": "E100", "name": "محمد",
    "kind": "DRIVER", "role": "DRIVER", "driver": true, "active": true, "source": "MASTER",
    "siteId": null, "siteName": null, "zoneId": "z1", "zoneName": "القاهرة",
    "live": { "userId": "emp_1", "employeeId": "emp_1", "lat": 30.04, "lng": 31.23,
              "speedKmh": 42, "motionState": "RIDING", "ts": "2026-10-22T06:31:04.000Z",
              "battery": 81, "accuracy": 8, "online": true, "tracking": true,
              "gpsEnabled": true, "dataEnabled": true, "lastSeen": "2026-10-22T06:31:05.000Z" } }
], "total": 1, "page": 1, "pageSize": 50 }
```

## 12. Places — Sites / Zones (المواقع والنطاقات)

قراءات `ADMIN`+`SUPERVISOR`؛ إنشاء/تعديل/حذف `ADMIN` فقط. المفتاح هنا: مخرج `GET /places/fences` هو `{ sites, zones, outside }` (ليس `GET /places` — لا يوجد مسار مُجرّد لهذا الاسم).

| Method | Path | الوصف |
|---|---|---|
| GET | `/places/org-tree` | جذور شجرة الوحدات التنظيمية `[{ id, code, name, parentId, children[] }]`. |
| GET | `/places/fences` | **`{ sites, zones, outside }`** — مغذّي خريطة الداش بورد (انظر الشكل أدناه). |
| GET | `/places/sites?active` · `/places/sites/:id` | صفوف `Site` الخام (مع `orgUnit`) — هنا `polygon` عمود نصي JSON. |
| GET | `/places/zones?active` · `/places/zones/:id` | صفوف `Zone` الخام؛ `/:id` يضيف `strictReject` من `Setting`. |
| GET | `/places/geofence-check?lat&lng&forUserId?` | تنقيح (`ADMIN`): هل النقطة داخل نطاق الموظف/أي نطاق نشِط. |
| POST/PATCH/DELETE | `/places/org-units(/:id)` · `/places/sites(/:id)` · `/places/zones(/:id)` | كتابات `ADMIN`. حذف مُستخدم ⇒ `ORGUNIT_IN_USE` / `FENCE_IN_USE:<counts>`. |

مُخرَج `GET /places/fences`:
- `sites[] = { id, kind:"SITE", code, name, orgUnitId, lat, lng, radiusM, polygon:[[lat,lng],…]|null, city:null, strictReject, attendance:{ expected, present, outOfFence } }`.
- `zones[] = { id, kind:"ZONE", shape:"CIRCLE"|"POLYGON", code, name, orgUnitId, lat, lng, radiusM, polygon:array|null, city:null, strictReject, maxSpeedKmh, stopAlertMin, driverCount, activeDriverIds[] }`.
- `outside` = مصفوفة معرّفات الموظفين-السواق الذين آخر موضع لهم خلال 24 ساعة يفشل نطاق منطقتهم.

نقاط عقدية مؤكَّدة:
- **`polygon` هنا مصفوفة `[[lat,lng],…]`** (وليست نصًا JSON) — تُمرَّر عبر `GeoService.ringOf` الذي يوحّد الاتجاه؛ وفي المسارات الخام (`/places/sites`·`/places/zones`) يبقى `polygon` نصًا.
- **`code` اختياري** عند الإنشاء؛ غيابه يولّد كودًا فريدًا `S-<slug>`/`Z-<slug>`؛ التصادم ⇒ `SITE_CODE_TAKEN`/`ZONE_CODE_TAKEN`. حلقة أقل من 3 نقاط أو إحداثيات غير صحيحة ⇒ `POLYGON_INVALID`.
- **`Zone.strictReject` لا يعمود له** في المخطط المجمّد؛ يُخزَّن في **`Setting(key='places.zone.strictReject.<zoneId>')`** بقيمة `"true"/"false"`، ويُدمَج في مخرج `zones`. (بينما `Site.strictReject` عمود حقيقي فعلًا.)
- `city` في `Site`/`Zone` دائمًا `null` (§14).

## 13. Rules & Settings (القواعد والإعدادات)

| Method | Path | الوصف |
|---|---|---|
| GET | `/settings` | `ADMIN`+`SUPERVISOR` → **`{ rules, timezone, notifications, preferences }`**. |
| PATCH | `/settings` | `ADMIN` فقط → يدمج في `rules.global` ويعيد `RulesPayload`. |
| GET | `/notifications/log` | `ADMIN`+`SUPERVISOR` → **`{ log: NotificationLogEntry[] }`**. |
| GET | `/me/preferences` | تفضيلات المُشغِّل الحالي المسطَّحة (`FlatPrefs`، انظر أدناه). |
| PATCH | `/me/preferences` | يقبل جسمًا مسطَّحًا جزئيًا ويعيد `FlatPrefs` الكامل + يبثّ `notify:me`. |
| GET | `/me/preferences/keys` | `{ knownKeys: string[] }`. |

**`rules` (`RulesPayload`)** = كل المفاتيح الرقمية لـ `RULE_DEFAULTS` مدموجة مع `Setting(key='rules.global')`: `maxSpeedKmh, stopAlertMin, geofenceGraceS, speedingCriticalS, cooldownS, gapMinMin, shiftGraceMin, replayMaxAgeHours, harshBrakingMs2, harshAccelMs2, speedSamples, accuracyDriftM` **بالإضافة إلى `attendanceStrictReject: boolean`**. `timezone` = `DASHBOARD_TIMEZONE`. `preferences` = تفضيلات المُشغِّل المسطَّحة.

`PATCH /settings` يقبل جسمًا مسطَّحًا أو `{ rules: {...} }`؛ يتحقّق من المفاتيح الرقمية (يُثبّت السالب عند 0 **عدا `harshBrakingMs2`** — هي تباطؤ ولازم تفضل سالبة، وأي قيمة غير رقمية ⇒ `BAD_RULE_VALUE`) ومن `attendanceStrictReject` (يجب `boolean`)؛ يحفظ في `rules.global` **ثم ينادي `RulesService.invalidate()`** لإسقاط الكاش ذا الـ30 ثانية فيقرأ المسار/الإرسال القيم الجديدة فورًا. كل مفاتيح `rules.global` الرقمية بتُقرأ من نفس السلسلة (`RuleOverride → Zone → Setting → RULE_DEFAULTS`) فأي خانة في الصفحة لها أثر فعلي على المحرك.

`GET /settings` / `/notifications/log` عنصر السجل: `{ id, alertId, alertType, channel:"push"|"whatsapp"|"socket"|"sms"|"email", userId, userName, status:"SENT"|"FAILED"|"PENDING"|"NO_PROVIDER", attempts, at, error, masked }` — `masked` يترك آخر 4 من هدف الـ push فقط (التوكن الخام لا يُعاد أبدًا).

**تفضيلات مسطَّحة** (`GET|PATCH /me/preferences`) — الجسم دائمًا `{ push, whatsapp, email, sound, types[] }`. التخزين في أعمدة `UserPreference` بمفاتيح نصية مجمّدة: `push.enabled`/`notify.whatsapp`/`notify.email`/`notify.sound` (منطق: `true` إلا إذا صراحةً `"false"`) و`push.mutedTypes` (CSV)؛ و`types = ALERT_TYPES \ mutedTypes` (لا تغيير مخطط).

## 14. Known schema limitations (قيود المخطط المعروفة)

المخطط المجمّد في `apps/api/prisma/schema.base.prisma` (محمول عبر المزوّدات: بلا `enum` أصلي (native) ولا نوع `Json` ولا تعليقات `@db.*`). الحقول التالية **لا يمكن تخزينها** في الأعمدة المولّدة؛ وكلٌّ يخزن/يُشتق كما هو موضّح:

| الحقل | البديل الفعلي |
|---|---|
| `Site.city` | لا عمود → يُخرَج دائمًا `null` في `GET /places/fences`. |
| `Zone.city` | لا عمود → يُخرَج دائمًا `null` في `GET /places/fences`. |
| `Zone.strictReject` | لا عمود في `Zone` → يُخزَّن في **`Setting(key='places.zone.strictReject.<zoneId>')`** بقيمة `"true"/"false"`، ويُدمَج في مخرج `zones` (`Site.strictReject` عمود حقيقي وليس قيدًا). |
| `SyncIssue.name` | لا عمود → يُستقصى من صف `Employee` بنفس `externalId` (وبدائله `externalId` نفسه). |
| `SyncIssue.createdAt` | لا عمود → يُستخدم `SyncRun.startedAt` للتشغيل المالك (أو `null`). |
| `Device.dataEnabled` | لا عمود → يُشتق من `Device.online` (وجود وصلة حيّة يعني البيانات تعمل) في `LivePosition`/`live`/`/drivers/presence`. |

مشتقات بلا أعمدة أخرى جديرة بالذكر: راية `replayed` في سجلات الحضور/التقارير لا عمود لها في `AttendanceRecord` — تُحسب من وجود نقاط `buffered/stale` لنفس الموظف+يوم العمل؛ ونطاق المشرف `scopeOrgUnitId` لا يُقرأ من التوكن بل من الداتا بيز (كاش 60ث في `JwtStrategy`).

## 15. Ops — أدوات التشغيل

| Method | Path | الوصف |
|---|---|---|
| POST | `/ops/reset-data` | `ADMIN`+`SUPERVISOR` → يمسح التاريخ التشغيلي كله ويترك المنظّمَة (السواقين/الأجهزة/القواعد). مع `includeFences:true` بيمسح **كل المناطق والمواقع** كمان، بعد ما يفضّي `zoneId` و`siteId` من الموظفين (الداش بورد بيرفض يحذف نطاق/موقع عليه ناس). |

**الجسم**: `{ apply?: boolean, confirm?: "RESET-OPS-DATA", includeFences?: boolean }`. بدون `apply:true` يرجع **معاينة** فقط `{ apply:false, wouldDelete, total }` (وبـ `includeFences` تزيد `fences:{Zone,Site}`)، ومع `apply:true` بلا عبارة التأكيد ⇒ `400 CONFIRM_REQUIRED`.

**النطاق (Zone) ≠ الموقع (Site):** النطاق ساحة تشغيل السواق وأساس `GEOFENCE_EXIT`/`STOP_EXCEEDED`/`SPEEDING` و`insideZone`، والموقع نقطة حضور الموظف (`siteId` + `distanceToSiteM` في سجل اليوم) و`strictReject` بيمنع التسجيل بره **للموظفين بس** (`attendance.service.ts:136`). الاتنين ليهم نفس الشكل على الخريطة ومفيش بينهم أي حساب مشترك. **الاتنين مش سييديين**: `prisma/seed.ts` ما بيبنيش fences خالص، فاللي يكوده المشرف من الداش بورد بيفضل بتاعه.

**المحذوف** (بترتيب آمن على المفاتيح الأجنبية، أولاد قبل آبائهم، في transaction واحد): `CallLog, NotificationLog, Alert, GeoEvent, RouteLine, StopEvent, Position, Trip, AttendanceRecord, LeaveRequest, SyncIssue, SyncRun` → `{ apply:true, deleted, total, remaining:0, kept }`.

**المبقي**: `OrgUnit, Site, Zone, Employee, User, Device, RuleOverride, Setting, SyncSource, ShiftSchedule, ShiftAssignment, UserPreference` (تُعاد أعداده في `kept`). بعد الحذف تُنادى `PositionsService.clearTrack()` لكل موظف حتى تُفرَّج مسارات الرحلات الحية في الذاكرة ولا يعرضها اللود من `RAM` بعد مسح الداتا.

**لماذا endpoint؟** بلان Render المجاني لا يعطي Shell ولا one-off jobs، فمفيش مكان تاني يقدر يشغّل سكربتًا بقيمة `DATABASE_URL` بتاعة التطبيق نفسه (سكربت `scripts/reset-ops-data.mjs` اتكتب الأول ومبقاش له محل على البلان ده، فاتشيل).
