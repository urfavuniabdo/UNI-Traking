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
| POST | `/auth/refresh` | `{ refreshToken }` → نفس شكل `login` تمامًا (`{ accessToken, refreshToken, user, mustChangePassword, changeOnLogin }`) |
| GET | `/auth/me` | → `{ user, profile, permissions[], mustChangePassword, scopeOrgUnitId }` — `profile` = ملفه الوظيفي (Employee) أو `null`، و`scopeOrgUnitId` نطاق رقابة المشرف (من الداتا بيز، لا من التوكن) |
| POST | `/auth/logout` | يقبل جسمًا اختياريًا `{}` (أو `{ refreshToken }`) → `{ ok: true }`. بلا `refreshToken` يُrevokes كل جلسات المستخدم الحالية (الداش بورد يسجّل الخروج بجسم فارغ). `RefreshDto.refreshToken` اختياري (`@IsOptional`). |
| POST | `/devices/register` | `{ token, platform: "android"\|"ios", appVersion, deviceId }` — idempotent بـ `deviceId` |
| POST | `/devices/heartbeat` | `{ deviceId, battery?, tracking: boolean, gpsEnabled: boolean, online: boolean }` كل 5 د |
| POST | `/devices/toggle-event` | `{ deviceId, kind: "GPS_OFF"\|"GPS_ON"\|"DATA_OFF"\|"DATA_ON"\|"APP_KILLED"\|"BUFFER_FLUSH" }` |

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

## 5. Motion-state classifier (مشروع مشترك API/Flutter)

مدخلات: `speedKmh`, `accuracyM`, ناقل الاتجاه، الزمن. ثوابت في `packages/shared/src/constants.ts` ويجب مطابقتها في `apps/mobile/lib/core/motion_states.dart`:

```
STATIONARY_SPEED_KMH   = 1.5    WALK_MAX_KMH = 7.0     RIDE_MIN_KMH = 7.0
SPEED_EMA_ALPHA        = 0.35    HYSTERESIS_SAMPLES = 3
ACCURACY_REJECT_M      = 35      MIN_INTERVAL_S = 2
MAX_CREDIBLE_SPEED_KMH = 250     // سقف الخطوة الواحدة في الأميال (انظر أدناه)
IDLE_ALARM_MIN         = 30      // توقف > 30 دقيقة ⇒ STOP_EXCEEDED
```

`STOPPED` ≤1.5 · `WALKING` 1.5–7 · `RIDING` >7 · `UNKNOWN` (دقة سيئة/لا بيانات). نقطة التحول تُخزن في `MotionSegment` وتظهر للإدارة كـ «ماشي / في رحلة / واقف».

**الأميال لا تجمع قفزات الـ GPS.** أي مجموع مسافة (`/positions/route`، `Trip.distanceKm`،
تقرير `mileage`) يمر عبر `GeoService.credibleDistanceM(a, b)`: الخطوة تُعدّ صفر كيلو متر لو
السرعة اللازمة لها تتجاوز `MAX_CREDIBLE_SPEED_KMH` (أو لو الزمن راجع/مكرّر). ده نفس السقف اللي
بيرفض بيه حارس القفزة الشاذة العينةَ نفسها، فالـ trip والحساب اليومي والشاشة كلها متفقين.
بدونه نفق أو إعادة تثبيت إشارة أو نقل بين موقعين كان بيضيف عشرات الكيلومترات لتقرير يوم واحد.

## 6. Rules engine → Alerts

كل تنبيه له `type` من القائمة في README + `severity`: `INFO` · `WARNING` · `CRITICAL`.

| النوع | الشرط الافتراضي | severity | audience |
|---|---|---|---|
| `GEOFENCE_EXIT` | خارج `Zone` لأكثر من `geofenceGraceS=120` | CRITICAL | السواق + المشرفون |
| `SPEEDING` | `speed > maxSpeedKmh` لمدة 3 عينات | WARNING→CRITICAL بعد `speedingCriticalS=120` | السواق + المشرفون |
| `HARSH_BRAKING` | دسليرة ≤ `-2.2 m/s²` | WARNING | المشرفون + السواق |
| `HARSH_ACCELERATION` | ≤ `2.2 m/s²`… (تسارع > `2.8 m/s²`) | INFO | المشرفون |
| `STOP_EXCEEDED` | `STOPPED` > 30 د | CRITICAL | المشرفون + السواق |
| `GPS_OFF` / `DATA_OFF` / `APP_OFFLINE` | حدث من الجهاز أو فوات قلب ≥ 3 فترات | CRITICAL | المشرفون + السواق |
| `BUFFER_REPLAYED` | وصول دفعة `buffered=true` | INFO | المشرفون |
| `CHECK_IN_OUT_OF_FENCE` | انطباق فاشل | WARNING | الطرفين |
| `ROUTE_GAP` | فجوة > `gapMinMin=10` د أثناء الرحلة | WARNING | المشرفون |

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

`PATCH /settings` يقبل جسمًا مسطَّحًا أو `{ rules: {...} }`؛ يتحقّق من المفاتيح الرقمية (يُثبّت السالب عند 0، وأي قيمة غير رقمية ⇒ `BAD_RULE_VALUE`) ومن `attendanceStrictReject` (يجب `boolean`)؛ يحفظ في `rules.global` **ثم ينادي `RulesService.invalidate()`** لإسقاط الكاش ذا الـ30 ثانية فيقرأ المسار/الإرسال القيم الجديدة فورًا.

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
