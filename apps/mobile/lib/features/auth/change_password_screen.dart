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
  bool _showOld = false;
  bool _showNew = false;
  bool _showConfirm = false;

  @override
  void initState() {
    super.initState();
    _new.addListener(_onChanged);
    _confirm.addListener(_onChanged);
  }

  void _onChanged() => setState(() {});

  @override
  void dispose() {
    _new.removeListener(_onChanged);
    _confirm.removeListener(_onChanged);
    _old.dispose();
    _new.dispose();
    _confirm.dispose();
    super.dispose();
  }

  bool get _lenOk => _new.text.length >= 8;
  bool get _match => _new.text.isNotEmpty && _new.text == _confirm.text;

  Future<void> _submit() async {
    if (_new.text.isEmpty || _confirm.text.isEmpty) return;
    if (_new.text != _confirm.text) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(S.t('pwMismatch'))),
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

  Widget _requirementsCard(BuildContext context) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: ShapeDecoration(
        color: TraccerTheme.brand.withValues(alpha: dark ? 0.12 : 0.05),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(
            color: TraccerTheme.brand.withValues(alpha: dark ? 0.25 : 0.15),
          ),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            S.t('pwRequirements'),
            style: const TextStyle(
              color: TraccerTheme.muted,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 6),
          _requirementRow(S.t('pwMinLength'), _lenOk),
          const SizedBox(height: 4),
          _requirementRow(S.t('pwMatch'), _match),
        ],
      ),
    );
  }

  static Widget _requirementRow(String label, bool ok) => Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(
            ok ? Icons.check_circle : Icons.radio_button_unchecked,
            size: 16,
            color: ok ? TraccerTheme.green : TraccerTheme.muted,
          ),
          const SizedBox(width: 8),
          Text(
            label,
            style: TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
              color: ok ? TraccerTheme.green : TraccerTheme.muted,
            ),
          ),
        ],
      );

  @override
  Widget build(BuildContext context) {
    final AuthState auth = ref.watch(authControllerProvider);
    final ThemeData theme = Theme.of(context);
    final String? error = auth.error;
    final TextStyle? labelStyle =
        theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w700);
    return Scaffold(
      appBar: AppBar(title: Text(S.t('mustChangePassword'))),
      body: SafeArea(
        bottom: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(S.t('currentPassword'), style: labelStyle),
              const SizedBox(height: 8),
              TextField(
                controller: _old,
                obscureText: !_showOld,
                enableSuggestions: false,
                autocorrect: false,
                keyboardType: TextInputType.text,
                textCapitalization: TextCapitalization.none,
                textInputAction: TextInputAction.next,
                autofillHints: const <String>[AutofillHints.password],
                decoration: _fieldDecoration(
                  context,
                  trailing: _eye(_showOld, () {
                    setState(() => _showOld = !_showOld);
                  }),
                ),
              ),
              const SizedBox(height: 16),
              Text(S.t('newPassword'), style: labelStyle),
              const SizedBox(height: 8),
              TextField(
                controller: _new,
                obscureText: !_showNew,
                enableSuggestions: false,
                autocorrect: false,
                keyboardType: TextInputType.text,
                textCapitalization: TextCapitalization.none,
                textInputAction: TextInputAction.next,
                autofillHints: const <String>[AutofillHints.newPassword],
                decoration: _fieldDecoration(
                  context,
                  trailing: _eye(_showNew, () {
                    setState(() => _showNew = !_showNew);
                  }),
                ),
              ),
              const SizedBox(height: 12),
              _requirementsCard(context),
              const SizedBox(height: 16),
              Text(S.t('confirmNewPassword'), style: labelStyle),
              const SizedBox(height: 8),
              TextField(
                controller: _confirm,
                obscureText: !_showConfirm,
                enableSuggestions: false,
                autocorrect: false,
                keyboardType: TextInputType.text,
                textCapitalization: TextCapitalization.none,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _submit(),
                decoration: _fieldDecoration(
                  context,
                  trailing: _eye(_showConfirm, () {
                    setState(() => _showConfirm = !_showConfirm);
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
                    : Text(S.t('saveNewPassword')),
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }
}
