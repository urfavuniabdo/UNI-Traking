# Flutter forces R8 minification on release builds. The dart:jni bridges that the
# "Built-in Kotlin" plugins (shared_preferences et al.) use resolve their Java
# counterparts BY NAME at runtime: suspend signatures carry a trailing
# kotlin.coroutines.Continuation, the bridge looks up kotlin stdlib types such as
# kotlin.coroutines.intrinsics.CoroutineSingletons directly, and it calls the plugin
# registrar methods (getAll/setString/…) reflectively. Renaming or stripping any of them
# hung the app on the splash screen (NoSuchMethodError, then ClassNotFoundException).
-keep class kotlin.** { *; }
-keep class kotlinx.** { *; }
-keep class io.flutter.plugins.** { *; }
