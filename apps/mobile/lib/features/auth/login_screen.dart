import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/app_strings.dart';
import '../../router.dart';
import '../../state/providers.dart';
import '../../theme.dart';

/// identifier = employee code + password. On `mustChangePassword` the router redirect takes
/// us to `/change-password`; otherwise straight to `/home`.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final TextEditingController _id = TextEditingController();
  final TextEditingController _pw = TextEditingController();

  @override
  void dispose() {
    _id.dispose();
    _pw.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_id.text.trim().isEmpty || _pw.text.isEmpty) return;
    final bool ok = await ref.read(authControllerProvider.notifier).login(
          _id.text.trim(),
          _pw.text,
        );
    if (!mounted) return;
    appRefresh.notify();
    if (ok) context.go('/home');
  }

  @override
  Widget build(BuildContext context) {
    final AuthState auth = ref.watch(authControllerProvider);
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const SizedBox(height: 48),
              Center(
                child: Container(
                  width: 72,
                  height: 72,
                  decoration: BoxDecoration(
                    color: TraccerTheme.brand,
                    borderRadius: BorderRadius.circular(20),
                    boxShadow: TraccerTheme.cardShadow(Theme.of(context).brightness == Brightness.dark),
                  ),
                  child: const Icon(Icons.location_on, color: Colors.white, size: 40),
                ),
              ),
              const SizedBox(height: 16),
              Text(S.t('appName'),
                  textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineMedium),
              Text(S.t('tagline'), textAlign: TextAlign.center,
                  style: const TextStyle(color: TraccerTheme.muted)),
              const SizedBox(height: 40),
              TextField(
                controller: _id,
                textInputAction: TextInputAction.next,
                keyboardType: TextInputType.text,
                decoration: InputDecoration(labelText: S.t('identifier'), filled: true, fillColor: Colors.white),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _pw,
                obscureText: true,
                onSubmitted: (_) => _submit(),
                decoration: InputDecoration(labelText: S.t('password'), filled: true, fillColor: Colors.white),
              ),
              if (auth.error != null) ...<Widget>[
                const SizedBox(height: 16),
                Text(auth.error!, style: const TextStyle(color: TraccerTheme.red)),
              ],
              const SizedBox(height: 32),
              FilledButton(
                onPressed: auth.busy ? null : _submit,
                child: auth.busy
                    ? const SizedBox(height: 24, width: 24, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : Text(S.t('enter')),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
