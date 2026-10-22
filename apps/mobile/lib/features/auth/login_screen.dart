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
  bool _showPw = false;

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

  static OutlineInputBorder _border(Color color, {double width = 1}) => OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: color, width: width),
      );

  InputDecoration _fieldDecoration(BuildContext context, {Widget? trailing}) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final Color idle = TraccerTheme.brand.withValues(alpha: dark ? 0.32 : 0.24);
    return InputDecoration(
      filled: true,
      fillColor: TraccerTheme.brand.withValues(alpha: dark ? 0.14 : 0.06),
      suffixIcon: trailing,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
      constraints: const BoxConstraints(minHeight: 56),
      border: _border(idle),
      enabledBorder: _border(idle),
      focusedBorder: _border(TraccerTheme.brand, width: 2),
      errorBorder: _border(TraccerTheme.red),
      focusedErrorBorder: _border(TraccerTheme.red, width: 2),
    );
  }

  static IconButton _eye(bool show, VoidCallback onTap) => IconButton(
        icon: Icon(
          show ? Icons.visibility_off : Icons.visibility,
          size: 22,
          color: TraccerTheme.muted,
        ),
        tooltip: show ? S.t('hidePassword') : S.t('showPassword'),
        onPressed: onTap,
      );

  static Widget _errorSlot(String? error) => SizedBox(
        height: 22,
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 160),
          child: error == null
              ? const SizedBox.shrink(key: ValueKey<String>('no-error'))
              : Text(
                  key: ValueKey<String>(error),
                  error,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: TraccerTheme.red,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final AuthState auth = ref.watch(authControllerProvider);
    final ThemeData theme = Theme.of(context);
    final String? error = auth.error;
    final TextStyle? labelStyle =
        theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w700);
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints viewport) {
            final double minInner = viewport.maxHeight > 32 ? viewport.maxHeight - 32 : 0;
            return SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: minInner),
                child: IntrinsicHeight(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      const Spacer(),
                      Center(
                        child: Container(
                          width: 72,
                          height: 72,
                          decoration: BoxDecoration(
                            color: TraccerTheme.brand,
                            borderRadius: BorderRadius.circular(20),
                            boxShadow:
                                TraccerTheme.cardShadow(theme.brightness == Brightness.dark),
                          ),
                          child: const Icon(Icons.location_on, color: Colors.white, size: 40),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(S.t('appName'),
                          textAlign: TextAlign.center,
                          style: theme.textTheme.headlineMedium),
                      Text(S.t('tagline'),
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: TraccerTheme.muted, fontSize: 13)),
                      const SizedBox(height: 28),
                      Text(S.t('identifier'), style: labelStyle),
                      const SizedBox(height: 8),
                      TextField(
                        controller: _id,
                        keyboardType: TextInputType.text,
                        textCapitalization: TextCapitalization.none,
                        textInputAction: TextInputAction.next,
                        autofillHints: const <String>[AutofillHints.username],
                        onSubmitted: (_) => _submit(),
                        decoration: _fieldDecoration(context),
                      ),
                      const SizedBox(height: 16),
                      Text(S.t('password'), style: labelStyle),
                      const SizedBox(height: 8),
                      TextField(
                        controller: _pw,
                        obscureText: !_showPw,
                        enableSuggestions: false,
                        autocorrect: false,
                        keyboardType: TextInputType.text,
                        textCapitalization: TextCapitalization.none,
                        textInputAction: TextInputAction.done,
                        autofillHints: const <String>[AutofillHints.password],
                        onSubmitted: (_) => _submit(),
                        decoration: _fieldDecoration(
                          context,
                          trailing: _eye(_showPw, () {
                            setState(() => _showPw = !_showPw);
                          }),
                        ),
                      ),
                      const SizedBox(height: 6),
                      _errorSlot(error),
                      const SizedBox(height: 10),
                      FilledButton(
                        style: FilledButton.styleFrom(
                          disabledBackgroundColor:
                              TraccerTheme.brand.withValues(alpha: 0.45),
                          disabledForegroundColor: Colors.white70,
                        ),
                        onPressed: auth.busy ? null : _submit,
                        child: auth.busy
                            ? const SizedBox(
                                height: 26,
                                width: 26,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2.5, color: Colors.white),
                              )
                            : Text(S.t('enter')),
                      ),
                      const Spacer(),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}
