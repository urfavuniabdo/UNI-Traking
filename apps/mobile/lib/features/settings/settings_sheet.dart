import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/app_strings.dart';
import '../../router.dart';
import '../../state/providers.dart';
import '../../theme.dart';

/// Bottom sheet with the only real user controls: notifications/sound, dark mode, logout.
Future<void> showSettingsSheet(BuildContext context, WidgetRef ref) {
  return showModalBottomSheet<void>(
    context: context,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (BuildContext ctx) => _SettingsSheet(ref: ref),
  );
}

class _SettingsSheet extends ConsumerStatefulWidget {
  const _SettingsSheet({required this.ref});
  final WidgetRef ref;

  @override
  ConsumerState<_SettingsSheet> createState() => _SettingsSheetState();
}

class _SettingsSheetState extends ConsumerState<_SettingsSheet> {
  @override
  Widget build(BuildContext context) {
    final bool sound = widget.ref.read(sessionStoreProvider).soundEnabled;
    final bool dark = widget.ref.watch(darkModeProvider);
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
                await widget.ref.read(sessionStoreProvider).setSoundEnabled(v);
                setState(() {});
              },
            ),
            SwitchListTile(
              title: Text(S.t('darkMode')),
              value: dark,
              activeColor: TraccerTheme.brand,
              onChanged: (bool v) async {
                await widget.ref.read(sessionStoreProvider).setDarkMode(v);
                widget.ref.read(darkModeProvider.notifier).state = v;
              },
            ),
            const Divider(),
            TextButton.icon(
              onPressed: () async {
                await widget.ref.read(authControllerProvider.notifier).logout();
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
