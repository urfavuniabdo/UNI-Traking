import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/app_strings.dart';
import '../../core/session_store.dart';
import '../../models/user.dart';
import '../../router.dart';
import '../../state/providers.dart';
import '../../theme.dart';

/// Compact, content-sized card with the only real user controls: notifications
/// sound, automatic tracking state, offline backlog, theme and sign-out.
void showSettingsSheet(BuildContext context) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (BuildContext ctx) => const _SettingsSheet(),
  );
}

String _roleAr(String role) => switch (role) {
      'ADMIN' => S.t('roleAdmin'),
      'SUPERVISOR' => S.t('roleSupervisor'),
      'DRIVER' => S.t('roleDriver'),
      _ => S.t('roleEmployee'),
    };

class _SettingsSheet extends ConsumerStatefulWidget {
  const _SettingsSheet();

  @override
  ConsumerState<_SettingsSheet> createState() => _SettingsSheetState();
}

class _SettingsSheetState extends ConsumerState<_SettingsSheet> {
  static const Duration _confirmWindow = Duration(seconds: 5);

  Timer? _confirmTimer;
  bool _confirmLogout = false;
  bool _signingOut = false;

  @override
  void dispose() {
    _confirmTimer?.cancel();
    super.dispose();
  }

  Future<void> _setSound(bool value) async {
    await ref.read(sessionStoreProvider).setSoundEnabled(value);
    if (mounted) setState(() {});
  }

  Future<void> _setDarkMode(bool value) async {
    await ref.read(sessionStoreProvider).setDarkMode(value);
    ref.read(darkModeProvider.notifier).state = value;
  }

  void _armLogout() {
    _confirmTimer?.cancel();
    setState(() => _confirmLogout = true);
    _confirmTimer = Timer(_confirmWindow, () {
      if (mounted) setState(() => _confirmLogout = false);
    });
  }

  void _cancelLogout() {
    _confirmTimer?.cancel();
    if (mounted) setState(() => _confirmLogout = false);
  }

  void _signOut() {
    if (_signingOut) return;
    _signingOut = true;
    _confirmTimer?.cancel();
    final AuthController auth = ref.read(authControllerProvider.notifier);
    final GoRouter router = GoRouter.of(context);
    Navigator.of(context).pop();
    unawaited(_completeSignOut(auth, router));
  }

  Future<void> _completeSignOut(AuthController auth, GoRouter router) async {
    await auth.logout();
    appRefresh.notify();
    router.go('/login');
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final Color muted = isDark ? const Color(0xFF94A3B8) : TraccerTheme.muted;
    final SessionStore session = ref.read(sessionStoreProvider);
    final AppUser? user = session.user;
    final HomeState home = ref.watch(homeControllerProvider);
    final bool dark = ref.watch(darkModeProvider);
    final double maxHeight = MediaQuery.sizeOf(context).height * 0.82;

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
          children: <Widget>[
            Center(
              child: Container(
                height: 4,
                width: 36,
                decoration: BoxDecoration(
                  color: muted.withValues(alpha: 0.45),
                  borderRadius: BorderRadius.circular(999),
                ),
              ),
            ),
            const SizedBox(height: 14),
            Text(S.t('settings'), style: theme.textTheme.titleLarge),
            if (user != null) ...<Widget>[
              const SizedBox(height: 12),
              _IdentityLine(
                name: user.name,
                code: user.identifier,
                role: _roleAr(user.role),
                muted: muted,
              ),
            ],
            const SizedBox(height: 12),
            _SwitchRow(
              icon: Icons.notifications_active_outlined,
              title: S.t('notifications'),
              subtitle: S.t('settingsNotificationsSubtitle'),
              value: session.soundEnabled,
              onChanged: (bool v) => unawaited(_setSound(v)),
            ),
            const SizedBox(height: 12),
            _InfoRow(
              icon: Icons.gps_fixed,
              title: !home.checkedIn
                  ? S.t('trackingIdle')
                  : (home.tracking ? S.t('trackingWorking') : S.t('trackingStopped')),
              subtitle: home.checkedIn
                  ? S.t('settingsTrackingOnShift')
                  : S.t('settingsTrackingNoShift'),
              accent: home.tracking ? TraccerTheme.green : muted,
            ),
            const SizedBox(height: 12),
            _InfoRow(
              icon: Icons.cloud_off,
              title: S.t('offlineBuffer'),
              value: '${home.pendingCount} ${S.t('points')}',
              accent: home.pendingCount > 0 ? TraccerTheme.amber : muted,
            ),
            const SizedBox(height: 12),
            _SwitchRow(
              icon: dark ? Icons.dark_mode : Icons.light_mode,
              title: S.t('darkMode'),
              value: dark,
              onChanged: (bool v) => unawaited(_setDarkMode(v)),
            ),
            const SizedBox(height: 16),
            Divider(height: 1, color: TraccerTheme.brand.withValues(alpha: isDark ? 0.22 : 0.12)),
            const SizedBox(height: 12),
            if (!_confirmLogout)
              _LogoutRow(label: S.t('logout'), onTap: _armLogout)
            else
              _LogoutConfirm(
                onCancel: _cancelLogout,
                onConfirm: _signOut,
                hint: S.t('logoutConfirmHint'),
              ),
          ],
        ),
      ),
    );
  }
}

class _IdentityLine extends StatelessWidget {
  const _IdentityLine({
    required this.name,
    required this.code,
    required this.role,
    required this.muted,
  });

  final String name;
  final String code;
  final String role;
  final Color muted;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Row(
      children: <Widget>[
        CircleAvatar(
          radius: 20,
          backgroundColor: TraccerTheme.brand.withValues(alpha: 0.14),
          child: Text(
            name.characters.isEmpty ? '?' : name.characters.first,
            style: const TextStyle(
              color: TraccerTheme.brand,
              fontWeight: FontWeight.w800,
              fontSize: 16,
            ),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 2),
              Text(
                '$code • $role',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: muted, fontWeight: FontWeight.w600),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _SwitchRow extends StatelessWidget {
  const _SwitchRow({
    required this.icon,
    required this.title,
    required this.value,
    required this.onChanged,
    this.subtitle,
  });

  final IconData icon;
  final String title;
  final String? subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final Color muted = isDark ? const Color(0xFF94A3B8) : TraccerTheme.muted;

    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 52),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => onChanged(!value),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            children: <Widget>[
              Icon(icon, size: 22, color: value ? TraccerTheme.brand : muted),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(
                      title,
                      style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    if (subtitle != null) ...<Widget>[
                      const SizedBox(height: 2),
                      Text(
                        subtitle!,
                        style: TextStyle(color: muted, fontSize: 12, height: 1.4),
                      ),
                    ],
                  ],
                ),
              ),
              Switch(
                value: value,
                activeThumbColor: TraccerTheme.brand,
                activeTrackColor: TraccerTheme.brand.withValues(alpha: isDark ? 0.45 : 0.32),
                onChanged: onChanged,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({
    required this.icon,
    required this.title,
    required this.accent,
    this.subtitle,
    this.value,
  });

  final IconData icon;
  final String title;
  final String? subtitle;
  final String? value;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool isDark = theme.brightness == Brightness.dark;
    final Color muted = isDark ? const Color(0xFF94A3B8) : TraccerTheme.muted;

    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 52),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: <Widget>[
            Icon(icon, size: 22, color: accent),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    title,
                    style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w700),
                  ),
                  if (subtitle != null) ...<Widget>[
                    const SizedBox(height: 2),
                    Text(
                      subtitle!,
                      style: TextStyle(color: muted, fontSize: 12, height: 1.4),
                    ),
                  ],
                ],
              ),
            ),
            if (value != null)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: isDark ? 0.18 : 0.10),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  value!,
                  style: TextStyle(color: accent, fontWeight: FontWeight.w700, fontSize: 12),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _LogoutRow extends StatelessWidget {
  const _LogoutRow({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 52),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            children: <Widget>[
              const Icon(Icons.logout, size: 22, color: TraccerTheme.red),
              const SizedBox(width: 12),
              Text(
                label,
                style: const TextStyle(
                  color: TraccerTheme.red,
                  fontWeight: FontWeight.w800,
                  fontSize: 16,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _LogoutConfirm extends StatelessWidget {
  const _LogoutConfirm({
    required this.onCancel,
    required this.onConfirm,
    required this.hint,
  });

  final VoidCallback onCancel;
  final VoidCallback onConfirm;
  final String hint;

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          hint,
          textAlign: TextAlign.start,
          style: TextStyle(
            color: isDark ? const Color(0xFF94A3B8) : TraccerTheme.muted,
            fontWeight: FontWeight.w700,
            fontSize: 13,
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: <Widget>[
            Expanded(
              child: OutlinedButton(
                onPressed: onCancel,
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                  foregroundColor: TraccerTheme.brand,
                  textStyle: const TextStyle(fontWeight: FontWeight.w700),
                ),
                child: Text(S.t('cancel')),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: FilledButton(
                onPressed: onConfirm,
                style: FilledButton.styleFrom(
                  backgroundColor: TraccerTheme.red,
                  padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 20),
                  textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                ),
                child: Text(S.t('confirmLogout')),
              ),
            ),
          ],
        ),
      ],
    );
  }
}
