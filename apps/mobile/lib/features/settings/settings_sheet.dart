import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/app_strings.dart';
import '../../router.dart';
import '../../state/providers.dart';
import '../../theme.dart';

/// Bottom sheet with the only real user controls: notifications/sound, dark mode, logout.
void showSettingsSheet(BuildContext context) {
  showModalBottomSheet<void>(
    context: context,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (BuildContext ctx) => const _SettingsSheet(),
  );
}

class _SettingsSheet extends ConsumerStatefulWidget {
  const _SettingsSheet();

  @override
  ConsumerState<_SettingsSheet> createState() => _SettingsSheetState();
}

class _SettingsSheetState extends ConsumerState<_SettingsSheet> {
  @override
  Widget build(BuildContext context) {
    final bool sound = ref.read(sessionStoreProvider).soundEnabled;
    final bool dark = ref.watch(darkModeProvider);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(S.t('settings'), style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 12),
            SwitchListTile(
              title: Text(S.t('sound')),
              value: sound,
              activeColor: TraccerTheme.brand,
              onChanged: (bool v) async {
                await ref.read(sessionStoreProvider).setSoundEnabled(v);
                setState(() {});
              },
            ),
            SwitchListTile(
              title: Text(S.t('darkMode')),
              value: dark,
              activeColor: TraccerTheme.brand,
              onChanged: (bool v) async {
                await ref.read(sessionStoreProvider).setDarkMode(v);
                ref.read(darkModeProvider.notifier).state = v;
              },
            ),
            const Divider(),
            TextButton.icon(
              onPressed: () async {
                await ref.read(authControllerProvider.notifier).logout();
                if (context.mounted) {
                  appRefresh.notify();
                  context.go('/login');
                }
              },
              icon: const Icon(Icons.logout, color: TraccerTheme.red),
              label: Text(S.t('logout'), style: const TextStyle(color: TraccerTheme.red)),
            ),
          ],
        ),
      ),
    );
  }
}
