# النشر على Render — UNI Tracking

ملف `render.yaml` في جذر الريبو هو المرجع: سيرفر واحد يقدّم الـ API + الـ Socket.IO +
الداش بورد نفسها من نفس الـ origin، مع PostgreSQL. مفيش CORS ولا عنوان تاني تظبطه.

```
https://<اسم-الخدمة>.onrender.com            ← الداش بورد
https://<اسم-الخدمة>.onrender.com/api/v1     ← الـ API (يتسجل عليه الموبايل)
https://<اسم-الخدمة>.onrender.com/api/v1/health
```

## 1) قبل ما تفتح Render (مرة واحدة)

Render بيسحب الكود من GitHub فقط. ده اتعمل خلاص:

```
origin = https://github.com/urfavuniabdo/UNI-Traking.git   (فرع master، ريبو public)
```

لو اتغير حاجة في الريبو بعدين:

```bash
cd "D:/UNI Track"
git push origin master
```

اللي بيتدفع هو اللي متسجّل في الـ commits فقط — أي تعديلات لسه ما اتعملهاش commit على
`apps/api` أو `apps/dashboard` ما بتوصلش لـ Render.

⚠️ **الـ push لوحدُه ما بيفلّش النشر** على الربط ده. الخدمة على `autoDeployTrigger: commit`
بس الـ Blueprint بيسحب الكود بـ "Use My Credentials" (توكن حسابك)، ومفيش Render GitHub App
منصّب على الريبو → مفيش webhook بيجيّ Render. المتابعات الفعلية كل trigger بتاعها
`Manual` أو `Blueprint`. بعد كل push:

1. الخدمة ← **Manual Deploy** ← **Deploy latest commit** (دقيقتين ونص: build للـ API
   والداش بورد، و`db push`، والسييد idempotent، وبعدين cut-over).
2. لو عايز النشر ييجي لوحده فعلاً: منصّب **Render GitHub App** على الريبو
   (github.com ← Settings ← Applications ← Render ← Configure ← Only select repositories
   ← `UNI-Traking`) — من غير التطبيق ده مفيش webhook يوصل Render، والتغيير ده محتاج صلاحيات
   على حسابك في GitHub فبيتنفّذ بيدك مش من غيرك.

## 2) إنشاء الخدمة

1. [dashboard.render.com](https://dashboard.render.com) ← **New +** ← **Blueprint**.
2. اختر الريبو، وافق على صلاحية Render لو أول مرة.
3. Render بيقرأ `render.yaml` نفسه ويعرض مصدر واحد: سيرفر `uni-tracking` (ويب).
   الداتابيز بقى تتربط يدوي لأن خطة Free بيسمحوا فيها بداتابيز PostgreSQL **واحدة** نشطة
   لكل workspace — لو slot محجوز (زي ما هو الحال دلوقتي بداتابيز مشروع تاني) فإن
   `fromDatabase` بيفشل والـ Blueprint بيلغاء إنشاء السيرفر كله.
4. عدّل `ADMIN_INIT_PASSWORD` من شاشة الـ Blueprint قبل الـ Apply (ده الباسورد اللي بيتعمل
   لكل حسابات السييد).
5. **Apply** ← السيرفر بيتخلق (بداية فاشلة طبيعية: `DATABASE_URL` فاضي).
6. من **Environment** للسيرفر: الصق `DATABASE_URL` ← **Save, rebuild and deploy**.
   ⚠️ **ما تصقش الـ connection string الافتراضي_Instance مباشرة.** الـ start command بيشغّل
   `prisma db push --accept-data-loss`، وPrisma بيحذف أي جدول موجود في الداتابيز ومش موجود
   في الـ schema تبعه — يعني لو الداتابيز دي عليها مشروع تاني فجدولاته هتتمسح مع أول deploy.
   العزل من غير خطة مدفوعة: دوخل على نفس الـ instance بـ **Connect / psql** ونفّذ
   `CREATE DATABASE uni_tracking;` (يوزر الأدمن عنده CREATEDB)، وبعدين خد الـ connection
   string **الـ internal** وغيّر آخر اسم فيه (اسم الداتابيز) إلى `uni_tracking` والصقه في
   `DATABASE_URL`. كل مشروع على نفس الـ instance بيبقى له داتابيز منطقية مستقلة، وحذف
   `uni_tracking` يمسح بيانات UNI Tracking وبس.
   لو عايز عزل على مستوى الـ instance نفسه: ارفع الداتابيز لخطة مدفوعة أو حط
   `fromDatabase` تاني بعد ما الـ slot بتاع خطة Free يتحرر.

اللي بيحصل في الـ deploy (مظبوط في `render.yaml`):

| الخطوة | الأمر |
|---|---|
| build | `npm ci --include=dev` في `apps/api`، و`npm ci --include=dev && npm run build` في `apps/dashboard`، ثم `npm run prisma:prod && npm run build` |
| تشغيل | `npx prisma db push --skip-generate --accept-data-loss` ثم `npx ts-node prisma/seed.ts` ثم `node dist/main.js` على `PORT` بتاع Render، مربوط على `0.0.0.0` |
| health | `GET /api/v1/ping` (ما يلمسش الداتابيز، فمافيش فرصة يفشل الـ probe) |

السييد والـ `db push` في الـ **startCommand** مش في `preDeployCommand`: Render بيقدّم
الـ pre-deploy command للخدمات المدفوعة فقط ("available for paid web services, private
services, and background workers"), وعلى خطة Free كان الهيكل ده هيتتجاهل والخدمة بتقوم
على داتابيز فاضية — مفيش حساب يسجّل دخول. الاتنين idempotent، فتكرارهم مع كل صحوة
للخدمة بيكلّف ثانيات بس.

**السييد بيُنشئ الناقص بس — ما بيكتبش فوق صف موجود** (`update: {}` في كل upsert)، ومابقاش يسيّد
**مناطق ولا مواقع** خالص. السبب إنه بيشتغل مع كل إقلاع: أي `update` فيه كان بيرجع التعديلات
اللي المشرف عملها من الداش بورد (منطقة رسمها، سواق غيّر اسمه، دور رقّاه) لقيم السييد مع
أول ديبلوي بعدها، وأي نطاق يمسحه كانت demo circles بترجع بعد مسحها.
الحارس: `apps/api/src/modules/ops/seed.spec.ts` (بيشغّل السييد مرتين على داتابيز مؤقتة).

`--include=dev` مش رفاهية: وجود `NODE_ENV=production` بيخلي `npm ci` يتجاهل devDependencies،
و`nest build` و`vite` و`prisma` و`ts-node` كلهم هناك — من غيرها الـ build يفشل في أول ثانية.

السييد idempotent (كل حاجة upsert)، فإعادة النشر ما ترجّعش باسورد اتغيّر.
اللي بيرجع الـ `ADMIN_INIT_PASSWORD` هو الحساب اللي لسه ما عملش أول دخول وخلاص — أي حساب
عدّى شاشة «تعيين كلمة مرور جديدة» بيحتفظ بباسورده الجديد عبر كل النشرات، فالـ smoke test
اللي بيسجّل دخول بـ `ChangeMe123!` بيفشل على الحسابات دي (مش باج، دي سياسة السييد).

## 3) أول تشغيل

النشرة دي شغّالة فعلًا على `https://uni-tracking.onrender.com` (الـ Blueprint
`exs-dbd679m7bikc73f8m4b0`)، والخدمة على `autoDeployTrigger: commit` — بس الـ push لوحده
مابيحرّكش النشر على الربط الحالي، راجع §1.

- افتح `https://<اسم-الخدمة>.onrender.com` وسجّل دخول بحساب من السييد
  (`admin` / `supervisor` / `E0101` موظف / `D0201` سواق) وباسورد `ADMIN_INIT_PASSWORD`.
  أول دخول بيطلب تغيير كلمة المرور.
- أي تطبيق جديد يسجّل دخول على نفس العنوان ده بيظهر فورًا في الداش بورد — نفس السيرفر
  ونفس الداتابيز، فالتست حقيقي مش mock.

## 4) ربط الموبايل

مش محتاج تعيد بناء الـ APK كل ما العنوان يتغير:

- **من جوه التطبيق** (الأسهل): الإعدادات ← **الخادم** ← اكتب الدومين بس
  (`uni-tracking.onrender.com`) ← **احفظ واختبر**. التطبيق بيفحص `/health` قبل ما يقبل
  ويستنى أول تشغيل لـ Render لحد ~75 ثانية (الخدمة النايمة بترفض الاتصال وبتشتغل ورا
  الطلب)، بيرجع العنوان القديم لو السيرفر ماردش فعلًا، وبيطلّعك على شاشة الدخول لأن
  التوكن تبع السيرفر القديم.
- **وقت البناء** (افتراضي مضمون):

```bash
cd apps/mobile
flutter build apk --release --dart-define=API_URL=https://<اسم-الخدمة>.onrender.com/api/v1
```

العنوان الافتراضي وقت البناء هو `https://uni-tracking.onrender.com/api/v1` (السيرفر المنشور
نفسه)، فأي APK بيتبنى دلوقتي بيربط نفسه على الديبلوي من غير ما تكتب حاجة — وللتطوير على
الإيموليتر مرر `--dart-define=API_URL=http://10.0.2.2:3000/api/v1`. وأي override من الإعدادات
بيتطبّق في كل الـ isolates (التتيع الخلفي وشغل الـ buffer) لأن `SessionStore.open()` هو اللي
بيطبقه.

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
| الصفحة بتفتح بس البيانات فاضية | السييد بيشغّل في `startCommand`؛ لو هو فشل الخدمة أصلاً ما تقومش — يبقى المسح متعمّد | امسح/أعد المسح من `POST /ops/reset-data` (انظر CONTRACT §15). بلان Render المجاني مفيهوش Shell ولا one-off jobs فماكانش ممكن نشغّل سكربت هنا |
| الموبايل بيقول "لا يوجد اتصال بالخادم" | الخدمة نايمة أو العنوان غلط | افتح `/api/v1/health` في المتصفح الأول، ثم راجع الإعدادات ← الخادم |
