import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/app_strings.dart';
import '../../core/session_store.dart';
import '../../router.dart';
import '../../state/providers.dart';
import '../../theme.dart';

/// Forced first-login password change (accounts created by employee-sync have
/// `changeOnLogin=true`, CONTRACT §8). The router will not let the user past this screen
/// until `mustChangePassword` clears.
class ChangePasswordScreen extends ConsumerStatefulWidget {
  const ChangePasswordScreen({super.key});

  @override
  ConsumerState<ChangePasswordScreen> createState() => _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends ConsumerState<ChangePasswordScreen> {
  final TextEditingController _old = TextEditingController();
  final TextEditingController _new = TextEditingController();
  final TextEditingController _confirm = TextEditingController();

  @override
  void dispose() {
    _old.dispose();
    _new.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_new.text != _confirm.text) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('كلمتا المرور غير متطابقتين')),
      );
      return;
    }
    final SessionStore session = ref.read(sessionStoreProvider);
    final String identifier = session.user?.identifier ?? '';
    final bool ok = await ref
        .read(authControllerProvider.notifier)
        .changePassword(identifier, _old.text, _new.text);
    if (ok && mounted) appRefresh.notify();
  }

  @override
  Widget build(BuildContext context) {
    final AuthState auth = ref.watch(authControllerProvider);
    return Scaffold(
      appBar: AppBar(title: Text(S.t('mustChangePassword'))),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: <Widget>[
          const SizedBox(height: 12),
          TextField(
            controller: _old,
            obscureText: true,
            decoration: InputDecoration(labelText: S.t('currentPassword')),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _new,
            obscureText: true,
            decoration: InputDecoration(labelText: S.t('newPassword')),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _confirm,
            obscureText: true,
            decoration: InputDecoration(labelText: S.t('confirmNewPassword')),
          ),
          if (auth.error != null) ...<Widget>[
            const SizedBox(height: 16),
            Text(auth.error!, style: const TextStyle(color: TraccerTheme.red)),
          ],
          const SizedBox(height: 32),
          FilledButton(
            onPressed: auth.busy ? null : _submit,
            child: Text(S.t('saveNewPassword')),
          ),
        ],
      ),
    );
  }
}
