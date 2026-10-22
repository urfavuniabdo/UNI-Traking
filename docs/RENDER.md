# النشر على Render — UNI Tracking

ملف `render.yaml` في جذر الريبو هو المرجع: سيرفر واحد يقدّم الـ API + الـ Socket.IO +
الداش بورد نفسها من نفس الـ origin، مع PostgreSQL. مفيش CORS ولا عنوان تاني تظبطه.

```
https://<اسم-الخدمة>.onrender.com            ← الداش بورد
https://<اسم-الخدمة>.onrender.com/api/v1     ← الـ API (يتسجل عليه الموبايل)
https://<اسم-الخدمة>.onrender.com/api/v1/health
```

## 1) قبل ما تفتح Render (مرة واحدة)

Render بيسحب الكود من GitHub فقط، فلازم الريبو يكون مرفوع:

```bash
cd "D:/UNI Track"
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin master
```

لو `git push` طلب credential: اعمل Personal Access Token من
GitHub ← Settings ← Developer settings ← Personal access tokens (scope: `repo`) واستخدمه
ككلمة السر.

## 2) إنشاء الخدمة

1. [dashboard.render.com](https://dashboard.render.com) ← **New +** ← **Blueprint**.
2. اختر الريبو، وافق على صلاحية Render لو أول مرة.
3. Render بيقرأ `render.yaml` نفسه ويعرض مصدرين: `uni-tracking` (web) و `uni-tracking-db` (Postgres).
4. عدّل `ADMIN_INIT_PASSWORD` من شاشة الـ Blueprint قبل الـ Apply (ده الباسورد اللي بيتعمل
   لكل حسابات السييد).
5. **Apply** ← أول deploy بيبدأ.

اللي بيحصل في الـ deploy (مظبوط في `render.yaml`):

| الخطوة | الأمر |
|---|---|
| build | `npm ci --include=dev` في `apps/api`، و`npm ci --include=dev && npm run build` في `apps/dashboard`، ثم `npm run prisma:prod && npm run build` |
| قبل التشغيل | `npx prisma db push --skip-generate --accept-data-loss` ثم `npx ts-node prisma/seed.ts` |
| تشغيل | `node dist/main.js` على `PORT` بتاع Render، مربوط على `0.0.0.0` |
| health | `GET /api/v1/ping` (ما يلمسش الداتابيز، فمافيش فرصة يفشل الـ probe) |

`--include=dev` مش رفاهية: وجود `NODE_ENV=production` بيخلي `npm ci` يتجاهل devDependencies،
و`nest build` و`vite` و`prisma` و`ts-node` كلهم هناك — من غيرها الـ build يفشل في أول ثانية.

السييد idempotent (كل حاجة upsert)، فإعادة النشر ما ترجّعش باسورد اتغيّر.

## 3) أول تشغيل

- افتح `https://<اسم-الخدمة>.onrender.com` وسجّل دخول بحساب من السييد
  (`admin` / `supervisor` / `E0101` موظف / `D0201` سواق) وباسورد `ADMIN_INIT_PASSWORD`.
  أول دخول بيطلب تغيير كلمة المرور.
- أي تطبيق جديد يسجّل دخول على نفس العنوان ده بيظهر فورًا في الداش بورد — نفس السيرفر
  ونفس الداتابيز، فالتست حقيقي مش mock.

## 4) ربط الموبايل

مش محتاج تعيد بناء الـ APK كل ما العنوان يتغير:

- **من جوه التطبيق** (الأسهل): الإعدادات ← **الخادم** ← اكتب الدومين بس
  (`uni-tracking.onrender.com`) ← **احفظ واختبر**. التطبيق بيفحص `/health` قبل ما يقبل،
  وبيرجع العنوان القديم لو السيرفر ماردش، وبيطلّعك على شاشة الدخول لأن التوكن تبع السيرفر
  القديم.
- **وقت البناء** (افتراضي مضمون):

```bash
cd apps/mobile
flutter build apk --release --dart-define=API_URL=https://<اسم-الخدمة>.onrender.com/api/v1
```

العنوان الافتراضي وقت البناء `http://10.0.2.2:3000/api/v1` (إيموليتر أندرويد)، وأي
override من الإعدادات بيتطبّق في كل الـ isolates (التتيع الخلفي وشغل الـ buffer) لأن
`SessionStore.open()` هو اللي بيطبقه.

## 5) حدود خطة Free (اعرفها عشان التست ما يفاجئكش)

- الخدمة بتنام بعد **15 دقيقة** من غير أي طلب داخل، وأول طلب بعدها بياخد ~50 ثانية
  (cold start). ده طبيعي على Free — التطبيق بيكمل شغل وأوف لاين بيخزّن النقاط ويرفعها
  أول ما التوصيل يرجع.
- **750 ساعة instance شهريًا** لكل workspace.
- **Postgres على Free بيخلص بعد 30 يوم من إنشائه.** قبل المدة دي إما ترقّي الداتابيز
  لخطة مدفوعة، أو تسيب `plan: free` وتربط سيرفر خارجي (Neon مثلًا) عن طريق تغيير الـ
  `DATABASE_URL` من الـ Blueprint.
- كل deploy بيقطع اتصالات الـ Socket.IO القائمة — العملاء بيرجعوا يتصلوا لوحدهم.

## 6) لو حصل مشكلة

| العرض | السبب | الحل |
|---|---|---|
| `Prepared statements could not be prepared` من Prisma | الداتابيز شغّالة على pgbouncer pooling | ضيف `?pgbouncer=true` لـ `DATABASE_URL` من لوحة Render |
| فشل `npm ci` في الـ build | `package-lock.json` غير متزامن مع `package.json` | استبدل `npm ci` بـ `npm install` في `render.yaml` |
| Health check timeout | المسار بيرجع غير 2xx/3xx خلال 5 ثواني | استخدم `/api/v1/ping` (مش `/health`) |
| الصفحة بتفتح بس البيانات فاضية | الداتابيز لسه ما اتسيّدتش | شغّل السييد يدوي من Render Shell: `npx ts-node prisma/seed.ts` |
| الموبايل بيقول "لا يوجد اتصال بالخادم" | الخدمة نايمة أو العنوان غلط | افتح `/api/v1/health` في المتصفح الأول، ثم راجع الإعدادات ← الخادم |
