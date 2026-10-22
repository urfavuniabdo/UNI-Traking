import 'package:flutter/material.dart';

/// Design language (README): Cairo font, brand #2563eb, white background, cards r16 with
/// thin blue shadows, calm/simple, Arabic RTL, dark-mode tokens.
class TraccerTheme {
  const TraccerTheme._();

  static const Color brand = Color(0xFF2563EB);
  static const Color brandDark = Color(0xFF1D4ED8);
  static const Color surfaceLight = Color(0xFFFFFFFF);
  static const Color inkLight = Color(0xFF0F172A);
  static const Color muted = Color(0xFF64748B);
  static const Color amber = Color(0xFFF59E0B);
  static const Color green = Color(0xFF16A34A);
  static const Color red = Color(0xFFDC2626);

  static const double cardRadius = 16;

  static List<BoxShadow> cardShadow(bool dark) => <BoxShadow>[
        BoxShadow(
          color: brand.withOpacity(dark ? 0.18 : 0.08),
          blurRadius: 18,
          offset: const Offset(0, 6),
        ),
      ];

  static ThemeData light() => _base(Brightness.light);
  static ThemeData dark() => _base(Brightness.dark);

  static ThemeData _base(Brightness brightness) {
    final bool dark = brightness == Brightness.dark;
    final ColorScheme scheme = ColorScheme.fromSeed(
      seedColor: brand,
      brightness: brightness,
      primary: brand,
      surface: dark ? const Color(0xFF0B1220) : surfaceLight,
    );

    final TextTheme base = ThemeData(brightness: brightness, fontFamily: 'Cairo').textTheme;
    final Color ink = dark ? Colors.white : inkLight;
    final TextTheme text = base.copyWith(
      bodyLarge: base.bodyLarge?.copyWith(color: ink),
      titleLarge: base.titleLarge?.copyWith(color: ink),
    );

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: dark ? const Color(0xFF0B1220) : surfaceLight,
      textTheme: text,
      fontFamily: 'Cairo',
      appBarTheme: AppBarTheme(
        centerTitle: true,
        backgroundColor: Colors.transparent,
        foregroundColor: dark ? Colors.white : inkLight,
        elevation: 0,
        titleTextStyle: TextStyle(
          fontFamily: 'Cairo',
          fontSize: 18,
          fontWeight: FontWeight.w700,
          color: dark ? Colors.white : inkLight,
        ),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: dark ? const Color(0xFF131C2E) : surfaceLight,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(cardRadius),
          side: BorderSide(color: brand.withOpacity(dark ? 0.25 : 0.12)),
        ),
        margin: EdgeInsets.zero,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: brand,
          foregroundColor: Colors.white,
          textStyle: const TextStyle(
            fontFamily: 'Cairo',
            fontSize: 20,
            fontWeight: FontWeight.w800,
          ),
          padding: const EdgeInsets.symmetric(vertical: 22, horizontal: 32),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: brand,
          textStyle: const TextStyle(fontFamily: 'Cairo', fontWeight: FontWeight.w700),
        ),
      ),
      dividerTheme: DividerThemeData(color: brand.withOpacity(0.12)),
    );
  }
}
