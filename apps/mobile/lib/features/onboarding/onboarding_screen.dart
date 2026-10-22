import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/app_strings.dart';
import '../../core/session_store.dart';
import '../../router.dart';
import '../../state/providers.dart';
import '../../theme.dart';

/// Three-step Arabic explainer the driver must clear once: automatic shift
/// tracking, "allow all the time" location permission and the battery
/// optimization exemption. Deep links only go through the existing adapters.
/// Writing `onboarded` on the session store is what releases the router gate.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  static const int _pageCount = 3;

  final PageController _pages = PageController(initialPage: 0);
  int _index = 0;
  bool _requesting = false;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  Future<void> _continue() async {
    setState(() => _requesting = true);
    final SessionStore session = ref.read(sessionStoreProvider);
    final bool isDriver = session.user?.isDriver ?? false;
    await ref.read(locationAdapterProvider).requestPermissions(background: isDriver);
    await ref.read(notificationsProvider).requestPermission();
    await session.setOnboarded(true);
    if (!mounted) return;
    appRefresh.notify();
    context.go('/home');
  }

  void _goTo(int page) {
    final int target = page.clamp(0, _pageCount - 1);
    if (target == _index) return;
    _pages.animateToPage(
      target,
      duration: const Duration(milliseconds: 280),
      curve: Curves.easeOutCubic,
    );
  }

  Future<void> _openLocationSettings() =>
      ref.read(locationAdapterProvider).openLocationSettings();

  Future<void> _openAppSettings() => ref.read(locationAdapterProvider).openSystemSettings();

  Widget _pageFor(int index, bool isDriver) {
    switch (index) {
      case 1:
        return _ExplainerPage(
          icon: Icons.location_on,
          accent: TraccerTheme.brand,
          title: S.t('onboardingLocation'),
          body: S.t('onboardingAlwaysAllow'),
          bullets: <String>[
            S.t('onboardingAlwaysAllowPath'),
            S.t('onboardingForegroundOnlyWarn'),
          ],
          actionLabel: S.t('openLocationSettings'),
          onAction: _openLocationSettings,
        );
      case 2:
        return _ExplainerPage(
          icon: Icons.battery_saver,
          accent: TraccerTheme.green,
          title: S.t('onboardingBatteryTitle'),
          body: S.t('batteryOptimizationWhy'),
          bullets: <String>[
            S.t('onboardingBatteryOemPath'),
            S.t('onboardingBatteryUnrestricted'),
            S.t('onboardingAutoLaunch'),
          ],
          actionLabel: S.t('batteryOptimization'),
          onAction: _openAppSettings,
          warning: S.t('onboardingKilledAlert'),
        );
      default:
        return _ExplainerPage(
          icon: Icons.autorenew,
          accent: TraccerTheme.brand,
          title: S.t('onboardingShiftTitle'),
          body: isDriver ? S.t('whyBackground') : S.t('whyBackgroundEmployee'),
          bullets: <String>[
            S.t('onboardingNoTrackingButton'),
            S.t('automatic'),
            S.t('offlineRealtimeNote'),
          ],
        );
    }
  }

  Widget _footer() {
    final bool isLast = _index == _pageCount - 1;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          children: <Widget>[
            if (_index > 0)
              TextButton.icon(
                onPressed: _requesting ? null : () => _goTo(_index - 1),
                icon: const Icon(Icons.arrow_back, size: 18),
                label: Text(S.t('back')),
              )
            else
              const SizedBox(height: 44),
            const Spacer(),
            _PageDots(index: _index, count: _pageCount),
          ],
        ),
        const SizedBox(height: 12),
        if (isLast)
          FilledButton(
            onPressed: _requesting ? null : _continue,
            child: _requesting
                ? const SizedBox(
                    height: 24,
                    width: 24,
                    child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white),
                  )
                : Text(S.t('allow')),
          )
        else
          FilledButton.icon(
            onPressed: _requesting ? null : () => _goTo(_index + 1),
            icon: const Icon(Icons.arrow_forward),
            label: Text(S.t('next')),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool isDriver = ref.read(sessionStoreProvider).user?.isDriver ?? false;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(
                S.t('onboardingTitle'),
                style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 12),
              Expanded(
                child: PageView.builder(
                  controller: _pages,
                  itemCount: _pageCount,
                  onPageChanged: (int page) => setState(() => _index = page),
                  itemBuilder: (BuildContext ctx, int page) => _pageFor(page, isDriver),
                ),
              ),
              const SizedBox(height: 12),
              _footer(),
            ],
          ),
        ),
      ),
    );
  }
}

class _ExplainerPage extends StatelessWidget {
  const _ExplainerPage({
    required this.icon,
    required this.accent,
    required this.title,
    required this.body,
    required this.bullets,
    this.actionLabel,
    this.onAction,
    this.warning,
  });

  final IconData icon;
  final Color accent;
  final String title;
  final String body;
  final List<String> bullets;
  final String? actionLabel;
  final VoidCallback? onAction;
  final String? warning;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final Color ink = isDark ? Colors.white : TraccerTheme.inkLight;

    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const SizedBox(height: 12),
          Center(
            child: Container(
              height: 68,
              width: 68,
              decoration: BoxDecoration(
                color: accent.withValues(alpha: isDark ? 0.22 : 0.12),
                borderRadius: BorderRadius.circular(20),
              ),
              child: Icon(icon, size: 34, color: accent),
            ),
          ),
          const SizedBox(height: 16),
          Text(title, textAlign: TextAlign.center, style: theme.textTheme.titleLarge),
          const SizedBox(height: 12),
          Text(
            body,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyLarge?.copyWith(
              color: ink.withValues(alpha: 0.86),
              height: 1.7,
            ),
          ),
          const SizedBox(height: 16),
          Card(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  for (final String bullet in bullets)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Padding(
                            padding: const EdgeInsets.only(top: 7),
                            child: Icon(Icons.circle, size: 7, color: accent),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              bullet,
                              style: TextStyle(
                                color: ink.withValues(alpha: 0.82),
                                height: 1.6,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),
          if (warning != null) ...<Widget>[
            const SizedBox(height: 12),
            _WarningTile(text: warning!),
          ],
          if (actionLabel != null) ...<Widget>[
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: onAction,
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(50),
                foregroundColor: TraccerTheme.brand,
                side: BorderSide(color: TraccerTheme.brand.withValues(alpha: 0.45)),
                textStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
              ),
              icon: const Icon(Icons.open_in_new),
              label: Text(actionLabel!),
            ),
          ],
          const SizedBox(height: 12),
        ],
      ),
    );
  }
}

class _WarningTile extends StatelessWidget {
  const _WarningTile({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: TraccerTheme.amber.withValues(alpha: isDark ? 0.16 : 0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: TraccerTheme.amber.withValues(alpha: 0.45)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.report_gmailerrorred, color: TraccerTheme.amber, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(fontWeight: FontWeight.w700, height: 1.5),
            ),
          ),
        ],
      ),
    );
  }
}

class _PageDots extends StatelessWidget {
  const _PageDots({required this.index, required this.count});

  final int index;
  final int count;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (int i = 0; i < count; i += 1)
          AnimatedContainer(
            duration: const Duration(milliseconds: 220),
            margin: const EdgeInsets.symmetric(horizontal: 4),
            height: 8,
            width: i == index ? 24 : 8,
            decoration: BoxDecoration(
              color: i == index
                  ? TraccerTheme.brand
                  : TraccerTheme.brand.withValues(alpha: 0.25),
              borderRadius: BorderRadius.circular(999),
            ),
          ),
      ],
    );
  }
}
