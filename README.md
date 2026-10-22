# UNI Tracking

تطبيق تتبع وحضور لموظفي Uni Group: موظف عام + سواقين، مع محرك قواعد وإشعارات لحظية.
الاسم الظاهر للمستخدم في كل مكان (أيقونة اللونشر، داخل التطبيق، الداش بورد) هو **UNI Tracking**؛
معرّف الحزمة `com.unigroup.traccer` واسم مشروع الريبو `UNI Track` يفضلوا ثابتين.

## المكوّنات

| المجلد | الوصف |
|---|---|
| `apps/api` | NestJS API + Socket.IO realtime + rules engine + push fan-out + sync worker |
| `apps/dashboard` | داش بورد الإدارة (React + Vite + Tailwind، RTL، نفس هوية `my asset tracking`) |
| `apps/mobile` | تطبيق Flutter (موظف / سواق) — واجهة السواق = بدء وردية / إنهاء وردية فقط |
| `packages/shared` | ثوابت وأسماء الأحداث/الأنواع المشتركة (TypeScript) |
| `docs` | العقود والمعمارية (`docs/CONTRACT.md` هو المرجع الملزم) |
| `_references` | مراجع مفتوحة المصدر مسحوبة للدراسة (Traccar, OwnTracks, traccar-client-android) — **لا تُستورد في البناء** |

## التشغيل (تطوير)

```bash
cp .env.example .env
cd apps/api && npm install && npm run prisma:dev && npm run seed && npm run dev
cd apps/dashboard && npm install && npm run dev
# apps/mobile: Flutter 3.47 + JDK 17 + Android SDK 36 — انظر apps/mobile/README.md
cd apps/mobile && flutter pub get && flutter run
# APK جاهز للتثبيت: dist/uni-tracking-0.1.0.apk (+ .sha256) — يحتاج الـ API يعمل على نفس الشبكة
```

قاعدة البيانات في التطوير: **SQLite** (`file:../../_data/traccer.db`) بدون حاجة لـ Docker أو PostGIS — كل حسابات الهندسة (نقطة داخل نطاق، مسافة، تبسيط خط السير) بتتعمل في التطبيق عن طريق `@turf/turf`، فالتبديل للإنتاج سطر واحد:

```bash
cd apps/api && npm run prisma:prod   # يولّد schema من schema.base.prisma بـ provider = postgresql
```

## النشر على Render

`render.yaml` في الجذر بيعرّف سيرفر واحد (NestJS + Socket.IO + الداش بورد من نفس الـ origin)
مع PostgreSQL. الخطوات الكاملة بالظبط وحدود خطة Free في **[`docs/RENDER.md`](docs/RENDER.md)**.

## الأدوار

| الدور | الرمز | الصلاحيات |
|---|---|---|
| Admin | `ADMIN` | كل شيء: موظفون، نطاقات، قواعد، مزامنة، أجهزة، حذف |
| Supervisor | `SUPERVISOR` | مراقبة، ack/resolve للتنبيهات، اتصال بالسواق، تقارير |
| Employee | `EMPLOYEE` | بدء وردية / إنهاء وردية في نطاق موقعه، سجله الشخصي |
| Driver | `DRIVER` | بدء وردية / إنهاء وردية في نطاق منطقته + تتبع تلقائي في الخلفية |

## أنواع التنبيهات (كلها تدفع Push + Realtime بدون استثناء)

`GEOFENCE_EXIT`, `GEOFENCE_ENTER`, `CHECK_IN_OUT_OF_FENCE`, `SPEEDING`, `HARSH_BRAKING`,
`HARSH_ACCELERATION`, `STOP_EXCEEDED`, `GPS_OFF`, `DATA_OFF`, `APP_OFFLINE`, `HEARTBEAT_MISSING`,
`BUFFER_REPLAYED`, `CHECKOUT_MISSING`, `ROUTE_GAP`, `MOTION_STATE_IDLE_LONG`.

## حالة الحركة المستنتجة (من السرعة + دقة الـ GPS)

`STOPPED` (≤1.5 كم/س) · `WALKING` (1.5–7) · `RIDING` (>7) · `UNKNOWN` — بهسترة 3 عيّنات ومتوسط EMA لمنع الاهتزاز.
