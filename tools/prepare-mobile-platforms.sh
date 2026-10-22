#!/usr/bin/env bash
# يولّد هياكل Android/iOS الناقصة لمشروع Flutter بدون ما يضيع التعديلات المكتوبة يدويًا
# (manifest وInfo.plist مكتوبين يدويًا: صلاحيات الموقع والـ foreground service).
# الاستخدام:  bash tools/prepare-mobile-platforms.sh [org]
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/apps/mobile"
ORG="${1:-com.unigroup.traccer}"
MANIFEST="android/app/src/main/AndroidManifest.xml"
PLIST="ios/Runner/Info.plist"
BACKUP_DIR="$(mktemp -d)"

cd "$MOBILE_DIR"

for f in "$MANIFEST" "$PLIST"; do
  if [ -f "$f" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp "$f" "$BACKUP_DIR/$f"
    echo "saved $f"
  fi
done

# لا يلمس pubspec.dart/lib — بيضيف الملفات الناقصة فقط
flutter create --org "$ORG" --project-name traccer_mobile --platforms=android,ios . > /tmp/flutter-create.log 2>&1 || {
  echo "flutter create فشل — استرجاع النسخ";
  for f in "$MANIFEST" "$PLIST"; do [ -f "$BACKUP_DIR/$f" ] && cp "$BACKUP_DIR/$f" "$f"; done
  exit 1
}

for f in "$MANIFEST" "$PLIST"; do
  if [ -f "$BACKUP_DIR/$f" ]; then
    mkdir -p "$(dirname "$f")"
    cp "$BACKUP_DIR/$f" "$f"
    echo "restored hand-written $f"
  fi
done

rm -rf "$BACKUP_DIR"
echo "تم. الملفات الأساسية:"
ls android/build.gradle android/settings.gradle android/gradle/wrapper/gradle-wrapper.properties "$MANIFEST" 2>&1 | sed 's/^/  /'
