# CONTRACT — المرجع الملزم

كل موديول (API / Flutter / Dashboard) لازم يلتزم بالأسماء والأشكال هنا. أي تغيير في العقد يتوثّق أولًا في هذا الملف.

Base URL: `/api/v1` — كل الطلبات محمية بـ `Authorization: Bearer <accessToken>` ما عدا `/auth/login` و `/health`.
كل التواريخ ISO-8601 UTC. الإحداثيات WGS84 عشرية (`lat`, `lng`) بنظام `decimal` degrees.

---

## 1. الأدوار والحماية

`ADMIN` · `SUPERVISOR` · `EMPLOYEE` · `DRIVER`

- `EMPLOYEE`/`DRIVER` يرون سجلهم الشخصي فقط (`/me/**`).
- `SUPERVISOR` و `ADMIN` يرون كل المستخدمين داخل نطاق رقابتهم (`scopeOrgUnitId` اختياري).
- إنشاء/تعديل النطاقات والقواعد والمزامنة والأجهزة: `ADMIN` فقط.
- ack/resolve/تعليق على التنبيهات: `SUPERVISOR` + `ADMIN`.

## 2. Auth & Devices

| Method | Path | الوصف |
|---|---|---|
| POST | `/auth/login` | `{ identifier, password }` → `{ accessToken, refreshToken, user }` |
| POST | `/auth/refresh` | `{ refreshToken }` → نفس الشكل |
| GET | `/auth/me` | المستخدم الحالي + صلاحياته + ملفه الوظيفي |
| POST | `/auth/logout` | إلغاء الجلسة |
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
| GET | `/attendance` | فلترة: `from,to,userId,siteId,status,page` (إدارة) |

قواعد التحقق: النقطة لازم تقع داخل نطاق العنصر (`Site` للموظف / `Zone` للسواق) حسب `GeoShape`.
النتيجة `VALID` أو `OUT_OF_FENCE` — مع `fenceName`, `distanceToCenterM`, `allowedFences[]` في الـ response.
`OUT_OF_FENCE` **لا يُرفض الطلب**؛ يُسجَّل مع رايات `exception: true` و`replayed: true` للدفعة المعاد بثها، ويُطلق تنبيه `CHECK_IN_OUT_OF_FENCE` للطرفين، إلا لو `settings.attendance.strictReject=true` ساعتها `422` بالكود `FENCE_VIOLATION`.
ممنوع تشيك ان مزدوج: `ALREADY_CHECKED_IN` (`409`). نهاية الوردية بفترة سماح `shiftGraceMin=30` ثم `CHECKOUT_MISSING`.

## 4. Position ingest (التتبع + إعادة البث أوف لاين)

`POST /positions/batch` — **نقطة الدخول الوحيدة** لبيانات الموقع.

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
- **Idempotency key:** `(userId, clientTs, lat, lng)` + `batchSeq` لكل جهاز؛ التكرار يُعيد `{ accepted: 0, deduped: n }` بدون خطأ — ده أساس مبدأ "إعادة البث تظهر كأنها لحظية".
- الحد الأقصى 500 نقطة/طلب. نقاط أقدم من `replayMaxAgeHours=72` تُخزَّن وتُوسم `stale: true`.
- Response: `{ accepted, deduped, rejected: [{index, reason}], alertsRaised: n, nextServerTs }`.
- `GET /positions/live?since=<ts>` و `GET /positions/route?userId&date` → polyline GeoJSON + فجوات.

## 5. Motion-state classifier (مشروع مشترك API/Flutter)

مدخلات: `speedKmh`, `accuracyM`, ناقل الاتجاه، الزمن. ثوابت في `packages/shared/src/constants.ts` ويجب مطابقتها في `apps/mobile/lib/core/motion_states.dart`:

```
STATIONARY_SPEED_KMH   = 1.5    WALK_MAX_KMH = 7.0     RIDE_MIN_KMH = 7.0
SPEED_EMA_ALPHA        = 0.35    HYSTERESIS_SAMPLES = 3
ACCURACY_REJECT_M      = 35      MIN_INTERVAL_S = 2
IDLE_ALARM_MIN         = 30      // توقف > 30 دقيقة ⇒ STOP_EXCEEDED
```

`STOPPED` ≤1.5 · `WALKING` 1.5–7 · `RIDING` >7 · `UNKNOWN` (دقة سيئة/لا بيانات). نقطة التحول تُخزن في `MotionSegment` وتظهر للإدارة كـ «ماشي / في رحلة / واقف».

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
كل alert يطابق `AlertPayload` في `packages/shared`:

```ts
{ id, type, severity, userId, userName, phone, orgUnitId, zoneId?, siteId?,
  title, body, createdAt, status: "OPEN"|"ACK"|"RESOLVED", ackBy?, ackAt?,
  meta: { lat, lng, speedKmh?, stopDurationS?, threshold?, offlineSince?, bufferCount? },
  channel: { push: boolean, socket: boolean, whatsapp?: "PENDING"|"SENT"|"NO_PROVIDER" } }
```

مسار التنبيهات: `GET /alerts?status&type&userId&from&to`, `POST /alerts/:id/ack`, `POST /alerts/:id/resolve` `{ note }`, `POST /alerts/:id/call-log` `{ called: boolean, note }` — وتسجيل مَن اتصل بالسواق ومتى.

## 7. Realtime (Socket.IO, namespace `/rt`)

`connect` مع `auth: { token }` → join rooms: `role:<ROLE>`, `watch:admins`, `user:<id>` (للموظف/السواق).

| Event | الاتجاه | الحمولة |
|---|---|---|
| `position:update` | → إداريين | `{ userId, lat, lng, speedKmh, motionState, ts }` |
| `alert:new` | → الكل المعني | `AlertPayload` كامل |
| `alert:updated` | → إداريين | `{ id, status, ackBy, ackAt }` |
| `attendance:changed` | → إداريين | `{ userId, kind, status, ts }` |
| `driver:presence` | → إداريين | `{ userId, online, tracking, gpsEnabled, lastSeen }` |
| `notify:me` | → السواق/الموظف | `{ title, body, alertType }` (تنبيه الشخص لنفسه) |
| `subscribe:live` / `subscribe:route` | ← العميل | `{ userIds?: [] }` |

Push (FCM/APNs) يطابق نفس الحدث ويوصل والتطبيق مقفول؛ أي حدث لا يصل له push يُعتبر خللًا ويُصفَّف في `notification_log` بحالة `FAILED` مع retry (3 مرات، backoff).

## 8. Employee sync (الداتا بيز الرئيسية)

 adapters: `sql` (توصيل مباشر) · `rest` (JSON endpoint) · `csv` (رفع ملف). كل adapter يخرّج نفس الصف:

```ts
{ externalId: string, name: string, phoneE164: string, roleHint?: "EMPLOYEE"|"DRIVER",
  orgUnit?: string, siteCode?: string, zoneCode?: string, active?: boolean }
```

- المفتوح عليه: `externalId` (معرّف الموظف في الداتا الرئيسية) — upsert idempotent: إدراج الجديد وتحديث المتغيّر فقط، **لا تكرار أبدا**، ولا حذف عند غياب العنصر (يتوسم `inactive` بدلًا من deletion).
- لا يُنشأ حساب بدون `phone` صحيح (إلزامي لواتساب/اتصال الطوارئ)؛ النقص يذهب لـ `SyncIssue` بدل الفشل الصامت.
- المشغلات: `POST /sync/runs` (يدوي)، `GET /sync/runs/:id`، مجدول بـ `SYNC_CRON` (افتراضي كل 15 د) + trigger عند أي تغيير عبر webhook `POST /sync/webhook?source=<id>` (header `x-sync-secret`).
- الربط بالمستخدم: `User.employeeId`؛ المستخدم الجديد ياخد كلمة مرور مؤقتة `changeOnLogin=true` واسمه معرّفه بالـ externalId.

## 9. Reports

`GET /reports/daily?date` · `/reports/route?userId&date` · `/reports/timesheet?from&to&userId` · `/reports/exceptions?from&to` · `/reports/mileage?from&to&groupBy=driver|zone` · `?format=csv` لنفس المسارات. كل تقرير فيه فصل صريح لبيانات معاد بثها (`replayed`) عن اللحظية.

## 10. متغيرات البيئة (`.env`)

`DATABASE_URL` · `JWT_SECRET` · `JWT_REFRESH_SECRET` · `PORT=3000` · `SYNC_CRON` · `REPLAY_MAX_AGE_HOURS=72` ·
`DEFAULT_MAX_SPEED_KMH=80` · `STOP_ALERT_MIN=30` · `GEOFENCE_GRACE_S=120` · `HEARTBEAT_INTERVAL_S=300` ·
`FCM_PROJECT_ID/FCM_CREDENTIALS_JSON` · `WACLOUD_TOKEN/WACLOUD_PHONE_NUMBER_ID` (اختياري) · `ADMIN_INIT_PASSWORD`.
