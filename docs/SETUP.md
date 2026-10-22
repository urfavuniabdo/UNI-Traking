# SETUP — تشغيل Traccer على جهازك/على السيرفر

## 0) الحالة الحالية على هذا الجهاز (مقيسة، مش مستنتجة)
| الأداة | الحالة |
|---|---|
| Node v24.19 + npm 11 | ✅ موجود — الـ API والداش بورد يشتغلا |
| git 2.56 | ✅ موجود — المراجع اتسحبت في `_references/` |
| .NET 8 | ✅ موجود (مش مستخدم في Traccer) |
| Docker | ❌ غير مثبّت — ده سبب إن التطوير ماشي على SQLite بدل PostgreSQL |
| Flutter / Dart SDK | ❌ غير مثبّت — كود الموبايل مكتوب بالكامل لكن **لم يُبنَ ولم يُتحقق منه بالكمبيوتر** |
| PostgreSQL محلي | ❌ لا يوجد سيرفر على 5432 |

## 1) الباك إند (يتشغّل دلوقتي)
```bash
cd "D:/UNI Track"
cp .env.example .env && cp .env apps/api/.env
cd apps/api
npm install
npm run prisma:dev && npx prisma db push --skip-generate
npm run seed
npm run dev            # http://localhost:3000/api/v1/health
```
- قاعدة البيانات: `_data/traccer.db` (SQLite). كل هندسة النطاقات بتتحسب بـ `@turf/turf` في التطبيق، فمفيش امتداد PostGIS مطلوب.
- التبديل للإنتاج: `npm run prisma:prod` + `DATABASE_URL=postgresql://...` ثم `npx prisma db push`.

## 2) الداش بورد
```bash
cd "D:/UNI Track/apps/dashboard"
npm install
npm run dev            # http://localhost:5173
```
- وضع الشاشات بدون باك إند: `VITE_USE_MOCK=1 npm run dev` (بيانات سواقين متحركة + تنبيهات لحظية تجريبية).
- للربط الحقيقي: `VITE_API_URL=http://localhost:3000/api/v1 VITE_USE_MOCK=0`.

## 3) تطبيق الموبايل (يحتاج Flutter SDK)
```bash
winget install --id Google.Flutter -e      # أو نزيله من flutter.io ثم:
cd "D:/UNI Track/apps/mobile"
flutter pub get
flutter doctor                          # نتأكد من Android SDK + JDK
flutter run -d <android-device-id> --dart-define=API_URL=http://10.0.2.2:3000/api/v1
```
- `10.0.2.2` = هوست الماكينة من داخل Android emulator. على جهاز حقيقي حط IP اللابتوب على نفس الشبكة.
- iOS: `flutter build ios --release` يحتاج macOS + Xcode (مستحيل من ويندوز).
- Firebase Push: بعد إنشاء مشروع Firebase → `flutterfire configure` بيولّد `firebase_options.dart`، و`google-services.json` في `android/app/` و`GoogleService-Info.plist` في `ios/Runner/`. بدونهم الإشعارات لحظية داخل الداش بورد فقط والتطبيق بيعمل polling للـ `/alerts`.

## 4) قنات التنبيهات
| القناة | المطلوب |
|---|---|
| Push (FCM/APNs) | `FCM_PROJECT_ID` + `FCM_CREDENTIALS_JSON` (service account JSON سطر واحد). من غيره الـ NotificationLog بيسجّل `NO_PROVIDER` بدون ما يقع السيرفر. |
| WebSocket (الداش بورد) | مفعّل دايمًا على namespace `/rt` — لا يحتاج مفاتيح. |
| واتساب | `WACLOUD_TOKEN` + `WACLOUD_PHONE_NUMBER_ID` من Meta Cloud API، مع `WACLOUD_ALLOWED_TO` قائمة أرقام مصرّح لها (قيد تجاري/24h template). |
| اتصال بشري | زر «اتصل بالسواق» في الداش بورد = `tel:` + `wa.me/<phone>`، ومسجّل في `CallLog` (مين كلّم مين وإمتى). |

## 5) مزامنة الموظفين من الداتا الرئيسية
اختار مصدر في `/sync` أو عدّل صف `SyncSource`:
- `kind: "csv"` — `config = {"filePath":"_data/employees.sample.csv"}`، الأعمدة: `externalId,name,phone,roleHint,siteCode,zoneCode,orgUnit`.
- `kind: "rest"` — `config = {"sourceUrl":"https://hr.internal/api/employees","token":"…","map":{…}}`.
- `kind: "sql"` — `config = {"connectionString":"postgresql://…","query":"SELECT emp_code AS \"externalId\", name, phone FROM employees"}` (قراءة فقط، مع whitelist للأعمدة).
- عندك SQL Server/Oracle/MySQL: لازم تتضيف الـ driver نفسه (`npm i mssql` مثلًا) — الواجهة جاهزة والموديول بيرمي `DriverNotInstalled` بالرسالة دي.
- المفتاح `externalId` = كود الموظف في الداتا الرئيسية. التشغيل مرتين على نفس البيانات = `created: N, updated: 0` في المرة التانية (مفيش تكرار أبداً)، والغياب عن المصدر = `active: false` مش حذف.
- رقم الموبايل إلزامي: أي سطر من غير رقم صحيح بيروح `SyncIssue(reason=MISSING_PHONE)` لأن بيه التنبيهات والطوارئ.

## 6) المراجع اللي اتسحبت (للدراية مش للبناء)
| المجلد | الترخيص | اخدنا منه |
|---|---|---|
| `_references/traccar` | Apache-2.0 | ترتيب الـ pipeline، عتبات overspeed/motion/geofence، نافذة تقادم الإشعارات، إعادة ترتيب الدفعات — موثّق في `docs/ENGINE-RULES.md` |
| `_references/traccar-client-android` | Apache-2.0 | شكل مخزن النقاط المحلي FIFO + حذف بعد الإقرار + تغيّر deviceId |
| `_references/owntracks` | MIT | مفهوم REC/beat وتخزين ما هو فارغ |
| **Jibble / Life360** | ❌ تجاريان مقفولا المصدر | ماخدناش كود؛ اتقليدنا خصائصهم المعلنة (ضبط الجداول والـ timesheet في Jibble، والـ geofence + location history في Life360) من الوثائق العامة. أي ادعاء بالعكس يكون غير دقيق |

## 7) اختبارات سريعة بعد التشغيل
```bash
cd apps/api && npm run test          # قواعد الهندسة + cooldown + ingest idempotency
curl -s localhost:3000/api/v1/health
# سيناريو كامل: تشيك ان → دفع نقاط → تجاوز سرعة → توقف 30د → قطع GPS → أوف لاين ثم replay
```
