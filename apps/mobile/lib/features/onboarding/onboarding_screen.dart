import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/app_strings.dart';
import '../../core/session_store.dart';
import '../../router.dart';
import '../../state/providers.dart';
import '../../theme.dart';

/// One-time permission explainer (task brief): "why we need it" Arabic copy + a
/// battery-optimization / location-settings helper. After tapping continue we persist
/// `onboarded` so the router lets the user reach `/home`.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  bool _requesting = false;

  Future<void> _continue() async {
    setState(() => _requesting = true);
    final AppUserIsDriver isDriver = AppUserIsDriver(ref.read(sessionStoreProvider));
    await ref
        .read(locationAdapterProvider)
        .requestPermissions(background: isDriver.value);
    await ref.read(notificationsProvider).requestPermission();
    await ref.read(sessionStoreProvider).setOnboarded(true);
    if (!mounted) return;
    appRefresh.notify();
    context.go('/home');
  }

  Future<void> _openLocation() => ref.read(locationAdapterProvider).openLocationSettings();
  Future<void> _openSystemSettings() => ref.read(locationAdapterProvider).openSystemSettings();

  void _showBatterySheet() {
    showModalBottomSheet<void>(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (BuildContext ctx) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(S.t('batteryOptimization'), style: Theme.of(ctx).textTheme.titleLarge),
            const SizedBox(height: 12),
            Text(S.t('batteryOptimizationWhy')),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: () async {
                await _openSystemSettings();
                if (ctx.mounted) Navigator.of(ctx).pop();
              },
              icon: const Icon(Icons.settings_battery),
              label: Text(S.t('batteryOptimization')),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const Spacer(),
              CircleAvatar(
                radius: 44,
                backgroundColor: TraccerTheme.brand.withOpacity(0.12),
                child: const Icon(Icons.location_searching, size: 44, color: TraccerTheme.brand),
              ),
              const SizedBox(height: 24),
              Text(S.t('onboardingTitle'),
                  style: Theme.of(context).textTheme.headlineSmall, textAlign: TextAlign.center),
              const SizedBox(height: 8),
              Text(S.t('onboardingLocation'),
                  style: Theme.of(context).textTheme.titleMedium, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    ref.read(sessionStoreProvider).user?.isDriver ?? false
                        ? S.t('whyBackground')
                        : S.t('whyBackgroundEmployee'),
                    style: const TextStyle(height: 1.6),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Text(S.t('offlineRealtimeNote'),
                  style: const TextStyle(color: TraccerTheme.muted, height: 1.5)),
              const Spacer(),
              OutlinedButton.icon(
                onPressed: _openLocation,
                icon: const Icon(Icons.edit_location_alt),
                label: Text(S.t('openLocationSettings')),
              ),
              TextButton.icon(
                onPressed: _showBatterySheet,
                icon: const Icon(Icons.battery_saver),
                label: Text(S.t('batteryOptimization')),
              ),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: _requesting ? null : _continue,
                child: Text(S.t('allow')),
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }
}

/// Tiny helper so we don't import the model just to read `isDriver`.
class AppUserIsDriver {
  AppUserIsDriver(SessionStore s) : value = s.user?.isDriver ?? false;
  final bool value;
}
