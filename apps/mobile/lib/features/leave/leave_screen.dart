import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_error.dart';
import '../../core/app_strings.dart';
import '../../core/cairo_time.dart';
import '../../core/traccer_constants.dart';
import '../../models/leave.dart';
import '../../state/providers.dart';
import '../../theme.dart';

/// Own leave requests (`/leave*`, CONTRACT §3): ask for a day or a range, watch the HR
/// decision land here. An approved day then locks "بدء اليوم" on the home screen.
class LeaveScreen extends ConsumerStatefulWidget {
  const LeaveScreen({super.key});

  @override
  ConsumerState<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends ConsumerState<LeaveScreen> {
  DateTime? _from;
  DateTime? _to;
  final TextEditingController _reason = TextEditingController();

  bool _sending = false;
  String? _formError;
  String? _sent;

  late Future<LeavePage> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<LeavePage> _load() => ref.read(apiClientProvider).myLeaveRequests();

  Future<void> _reload() async {
    final Future<LeavePage> next = _load();
    setState(() => _future = next);
    await next.catchError((Object _) => LeavePage.empty);
  }

  Future<void> _pickDate({required bool to}) async {
    final DateTime now = DateTime.now();
    final DateTime? picked = await showDatePicker(
      context: context,
      initialDate: (to ? _to : _from) ?? _from ?? now,
      firstDate: now.subtract(const Duration(days: 60)),
      lastDate: now.add(const Duration(days: 365)),
    );
    if (picked == null || !mounted) return;
    setState(() {
      if (to) {
        _to = picked;
      } else {
        _from = picked;
        // Keep the range valid when the start moves past a chosen end.
        if (_to != null && _to!.isBefore(picked)) _to = picked;
      }
      _formError = null;
    });
  }

  Future<void> _send() async {
    final DateTime? from = _from;
    if (from == null) {
      setState(() => _formError = S.t('leavePickFromFirst'));
      return;
    }
    final DateTime to = _to ?? from;
    if (to.isBefore(from)) {
      setState(() => _formError = S.t('leaveBadRange'));
      return;
    }
    setState(() {
      _sending = true;
      _formError = null;
      _sent = null;
    });
    try {
      await ref.read(apiClientProvider).createLeave(
            dateFrom: CairoTime.iso(from),
            dateTo: CairoTime.iso(to),
            reason: _reason.text.trim(),
          );
      _reason.clear();
      await _reload();
      if (mounted) {
        setState(() => _sent = S.t('leaveSent'));
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _formError = e.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _cancel(LeaveRequest row) async {
    final bool sure = await _confirmCancel(row);
    if (!sure) return;
    try {
      await ref.read(apiClientProvider).cancelLeave(row.id);
      await _reload();
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(S.t('leaveCancelledDone'))));
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<bool> _confirmCancel(LeaveRequest row) async {
    final bool? yes = await showDialog<bool>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        title: Text(S.t('leaveCancel')),
        content: Text(leaveRangeLabel(row)),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(S.t('cancel'))),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(S.t('leaveCancel'))),
        ],
      ),
    );
    return yes ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(S.t('leaveTitle')),
            Text(
              S.t('leaveSubtitle'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: TraccerTheme.muted),
            ),
          ],
        ),
      ),
      body: RefreshIndicator(
        onRefresh: _reload,
        color: TraccerTheme.brand,
        child: FutureBuilder<LeavePage>(
          future: _future,
          builder: (BuildContext _, AsyncSnapshot<LeavePage> snap) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 20),
            children: <Widget>[
              _RequestForm(
                from: _from,
                to: _to,
                reason: _reason,
                sending: _sending,
                error: _formError,
                sent: _sent,
                onPickFrom: () => _pickDate(to: false),
                onPickTo: () => _pickDate(to: true),
                onSend: _send,
                onClearNotice: () => setState(() => _sent = null),
              ),
              const SizedBox(height: 14),
              Text(
                S.t('leaveHistoryTitle'),
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  color: isDark ? Colors.white : TraccerTheme.inkLight,
                ),
              ),
              const SizedBox(height: 8),
              ..._rows(snap, isDark),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _rows(AsyncSnapshot<LeavePage> snap, bool isDark) {
    if (snap.connectionState == ConnectionState.waiting) {
      return const <Widget>[
        _LeaveSkeleton(),
      ];
    }
    if (snap.hasError) {
      final Object? error = snap.error;
      return <Widget>[
        _StatePane(
          icon: Icons.cloud_off,
          message: error is ApiException ? error.message : S.t('noConnection'),
          onRetry: _reload,
        ),
      ];
    }
    final List<LeaveRequest> items = snap.data?.items ?? const <LeaveRequest>[];
    if (items.isEmpty) {
      return <Widget>[_StatePane(icon: Icons.beach_access_outlined, message: S.t('leaveEmpty'))];
    }
    return <Widget>[
      for (int i = 0; i < items.length; i++) ...<Widget>[
        _LeaveRow(row: items[i], isDark: isDark, onCancel: () => _cancel(items[i])),
        if (i != items.length - 1) const SizedBox(height: 8),
      ],
    ];
  }
}

/// One day reads "الثلاثاء 3 نوفمبر"; a range reads "من يوم ← إلى يوم" in RTL order.
String leaveRangeLabel(LeaveRequest row) {
  final String from = CairoTime.formatDayAr(DateTime.parse(row.dateFrom));
  if (row.dateTo == row.dateFrom) return from;
  return '$from ← ${CairoTime.formatDayAr(DateTime.parse(row.dateTo))}';
}

/// Date pickers + reason + send, kept in one card so the request is one screen tall.
class _RequestForm extends StatelessWidget {
  const _RequestForm({
    required this.from,
    required this.to,
    required this.reason,
    required this.sending,
    required this.error,
    required this.sent,
    required this.onPickFrom,
    required this.onPickTo,
    required this.onSend,
    required this.onClearNotice,
  });

  final DateTime? from;
  final DateTime? to;
  final TextEditingController reason;
  final bool sending;
  final String? error;
  final String? sent;
  final VoidCallback onPickFrom;
  final VoidCallback onPickTo;
  final Future<void> Function() onSend;
  final VoidCallback onClearNotice;

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(TraccerTheme.cardRadius),
        boxShadow: TraccerTheme.cardShadow(isDark),
      ),
      child: Card(
        clipBehavior: Clip.antiAlias,
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(
                S.t('leaveFormTitle'),
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  color: isDark ? Colors.white : TraccerTheme.inkLight,
                ),
              ),
              const SizedBox(height: 10),
              _DateField(
                label: S.t('leaveFrom'),
                value: from == null ? null : CairoTime.formatDayAr(from!),
                onTap: onPickFrom,
                isDark: isDark,
              ),
              const SizedBox(height: 8),
              _DateField(
                label: S.t('leaveTo'),
                hint: S.t('leaveToHint'),
                value: to == null ? null : CairoTime.formatDayAr(to!),
                onTap: onPickTo,
                isDark: isDark,
              ),
              const SizedBox(height: 10),
              TextField(
                controller: reason,
                minLines: 2,
                maxLines: 3,
                textInputAction: TextInputAction.newline,
                decoration: InputDecoration(
                  labelText: S.t('leaveReason'),
                  hintText: S.t('leaveReasonHint'),
                  alignLabelWithHint: true,
                ),
              ),
              if (error != null) ...<Widget>[
                const SizedBox(height: 10),
                _Strip(message: error!, color: TraccerTheme.red, isDark: isDark),
              ],
              if (sent != null) ...<Widget>[
                const SizedBox(height: 10),
                Semantics(
                  liveRegion: true,
                  child: _Strip(
                    message: sent!,
                    color: TraccerTheme.green,
                    isDark: isDark,
                    onTap: onClearNotice,
                  ),
                ),
              ],
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: sending ? null : onSend,
                icon: sending
                    ? const SizedBox(
                        height: 16,
                        width: 16,
                        child: CircularProgressIndicator(strokeWidth: 2.2, color: Colors.white),
                      )
                    : const Icon(Icons.send_rounded, size: 18),
                label: Text(sending ? S.t('leaveSending') : S.t('leaveSend')),
                style: FilledButton.styleFrom(
                  backgroundColor: TraccerTheme.brand,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DateField extends StatelessWidget {
  const _DateField({
    required this.label,
    required this.value,
    required this.onTap,
    required this.isDark,
    this.hint,
  });

  final String label;
  final String? value;
  final String? hint;
  final VoidCallback onTap;
  final bool isDark;

  @override
  Widget build(BuildContext context) {
    final bool hasValue = value != null;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 9, 12, 10),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: hasValue ? TraccerTheme.brand : Theme.of(context).dividerColor),
        ),
        child: Row(
          children: <Widget>[
            Icon(
              hasValue ? Icons.event_available : Icons.event_busy_outlined,
              size: 18,
              color: hasValue ? TraccerTheme.brand : TraccerTheme.muted,
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    label,
                    style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: TraccerTheme.muted),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    value ?? (hint ?? '—'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: hasValue ? 14 : 12.5,
                      fontWeight: hasValue ? FontWeight.w800 : FontWeight.w500,
                      color: hasValue
                          ? (isDark ? Colors.white : TraccerTheme.inkLight)
                          : TraccerTheme.muted,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LeaveRow extends StatelessWidget {
  const _LeaveRow({required this.row, required this.isDark, required this.onCancel});

  final LeaveRequest row;
  final bool isDark;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final ({String label, Color color}) status = _statusOf(row);
    final String range = leaveRangeLabel(row);

    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(TraccerTheme.cardRadius),
        boxShadow: TraccerTheme.cardShadow(isDark),
      ),
      child: Card(
        clipBehavior: Clip.antiAlias,
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Expanded(
                    child: Text(
                      range,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w800,
                        color: isDark ? Colors.white : TraccerTheme.inkLight,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  _StatusPill(label: status.label, color: status.color),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                '${row.days} ${S.t('leaveDays')}',
                style: const TextStyle(fontSize: 11.5, color: TraccerTheme.muted),
              ),
              if (row.reason != null && row.reason!.isNotEmpty) ...<Widget>[
                const SizedBox(height: 6),
                Text(
                  row.reason!,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    height: 1.35,
                    color: isDark ? Colors.white70 : TraccerTheme.inkLight,
                  ),
                ),
              ],
              if (!row.isPending) ...<Widget>[
                const SizedBox(height: 7),
                Text(
                  '${S.t('leaveDecidedBy')}: ${row.decidedByName ?? '—'}'
                  '${row.decidedAt == null ? '' : ' · ${CairoTime.formatDayAr(row.decidedAt!.toLocal())}'}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11.5, color: TraccerTheme.muted),
                ),
                if (row.decisionNote != null && row.decisionNote!.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 4),
                  Text(
                    row.decisionNote!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: TraccerTheme.muted),
                  ),
                ],
              ],
              if (row.isPending) ...<Widget>[
                const SizedBox(height: 8),
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: TextButton.icon(
                    onPressed: onCancel,
                    icon: const Icon(Icons.close_rounded, size: 16),
                    label: Text(S.t('leaveCancel')),
                    style: TextButton.styleFrom(
                      foregroundColor: TraccerTheme.red,
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  static ({String label, Color color}) _statusOf(LeaveRequest row) => switch (row.status) {
        LeaveStatus.approved => (label: LeaveStatus.ar[row.status]!, color: TraccerTheme.green),
        LeaveStatus.rejected => (label: LeaveStatus.ar[row.status]!, color: TraccerTheme.red),
        LeaveStatus.cancelled => (label: LeaveStatus.ar[row.status]!, color: TraccerTheme.muted),
        _ => (label: LeaveStatus.ar[row.status] ?? row.status, color: TraccerTheme.leave),
      };
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 124),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.circle, size: 7, color: color),
          const SizedBox(width: 5),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: color),
            ),
          ),
        ],
      ),
    );
  }
}

/// One-tap inline strip for the send result — no dialog, nothing leaves the card.
class _Strip extends StatelessWidget {
  const _Strip({required this.message, required this.color, required this.isDark, this.onTap});

  final String message;
  final Color color;
  final bool isDark;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
        decoration: BoxDecoration(
          color: color.withValues(alpha: isDark ? 0.18 : 0.10),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.35)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Icon(Icons.info_outline, size: 15, color: _legible(color, isDark)),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                message,
                style: TextStyle(
                  fontSize: 12.5,
                  height: 1.35,
                  fontWeight: FontWeight.w700,
                  color: _legible(color, isDark),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  static Color _legible(Color color, bool dark) =>
      dark ? Color.lerp(color, Colors.white, 0.32)! : color;
}

class _StatePane extends StatelessWidget {
  const _StatePane({required this.icon, required this.message, this.onRetry});

  final IconData icon;
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 40, color: TraccerTheme.muted),
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: TraccerTheme.muted, fontSize: 14, height: 1.4),
            ),
          ),
          if (onRetry != null) ...<Widget>[
            const SizedBox(height: 14),
            OutlinedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh, size: 18),
              label: Text(S.t('retry')),
              style: OutlinedButton.styleFrom(
                foregroundColor: TraccerTheme.brand,
                side: const BorderSide(color: TraccerTheme.brand),
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _LeaveSkeleton extends StatelessWidget {
  const _LeaveSkeleton();

  @override
  Widget build(BuildContext context) {
    final Color tint = TraccerTheme.brand.withValues(
      alpha: Theme.of(context).brightness == Brightness.dark ? 0.18 : 0.07,
    );
    return Semantics(
      label: S.t('loading'),
      child: Column(
        children: <Widget>[
          for (int i = 0; i < 3; i++) ...<Widget>[
            Card(
              clipBehavior: Clip.antiAlias,
              margin: EdgeInsets.zero,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                child: Row(
                  children: <Widget>[
                    Expanded(child: Container(height: 16, decoration: _block(tint))),
                    const SizedBox(width: 10),
                    Container(width: 84, height: 22, decoration: _block(tint)),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 8),
          ],
        ],
      ),
    );
  }

  static BoxDecoration _block(Color tint) => BoxDecoration(
        color: tint,
        borderRadius: BorderRadius.circular(6),
      );
}
