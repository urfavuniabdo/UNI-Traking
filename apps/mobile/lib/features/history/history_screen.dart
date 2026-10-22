import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/api_error.dart';
import '../../core/app_strings.dart';
import '../../core/cairo_time.dart';
import '../../core/traccer_constants.dart';
import '../../models/attendance.dart';
import '../../state/providers.dart';
import '../../theme.dart';

/// Own attendance records only (CONTRACT §1: EMPLOYEE/DRIVER see personal `/me/**`).
class HistoryScreen extends ConsumerStatefulWidget {
  const HistoryScreen({super.key});

  @override
  ConsumerState<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends ConsumerState<HistoryScreen> {
  static const int _windowDays = 30;

  late Future<List<AttendanceDay>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<AttendanceDay>> _load() {
    final ApiClient api = ref.read(apiClientProvider);
    final DateTime now = DateTime.now();
    return api.history(from: now.subtract(const Duration(days: _windowDays)), to: now);
  }

  Future<void> _reload() async {
    final Future<List<AttendanceDay>> next = _load();
    setState(() => _future = next);
    await next.catchError((Object _) => const <AttendanceDay>[]);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(S.t('history'))),
      body: RefreshIndicator(
        onRefresh: _reload,
        color: TraccerTheme.brand,
        child: Semantics(
          label: S.t('pullToRefresh'),
          child: FutureBuilder<List<AttendanceDay>>(
            future: _future,
            builder: (BuildContext ctx, AsyncSnapshot<List<AttendanceDay>> snap) => _buildBody(snap),
          ),
        ),
      ),
    );
  }

  Widget _buildBody(AsyncSnapshot<List<AttendanceDay>> snap) {
    if (snap.connectionState == ConnectionState.waiting) {
      return const _HistorySkeleton();
    }
    if (snap.hasError) {
      final Object? error = snap.error;
      return _StatePane(
        icon: Icons.cloud_off,
        message: error is ApiException ? error.message : S.t('noConnection'),
        onRetry: _reload,
      );
    }
    final List<AttendanceDay> days = snap.data ?? const <AttendanceDay>[];
    if (days.isEmpty) {
      return _StatePane(icon: Icons.event_note_outlined, message: S.t('historyEmpty'));
    }
    return _HistoryList(groups: _groupByDay(days));
  }
}

/// One calendar day + its records (`/attendance/me/history` returns a row per record).
class _DayGroup {
  const _DayGroup({required this.date, required this.records});

  final DateTime date;
  final List<AttendanceDay> records;

  Duration get totalDuration {
    Duration sum = Duration.zero;
    final DateTime now = DateTime.now();
    for (final AttendanceDay record in records) {
      final DateTime? checkIn = record.checkInAt?.toLocal();
      if (checkIn == null) continue;
      final DateTime? checkOut = record.checkOutAt?.toLocal();
      if (checkOut == null) {
        if (CairoTime.iso(checkIn) == CairoTime.iso(now)) {
          sum += now.difference(checkIn);
        }
        continue;
      }
      if (checkOut.isAfter(checkIn)) sum += checkOut.difference(checkIn);
    }
    return sum;
  }
}

List<_DayGroup> _groupByDay(List<AttendanceDay> days) {
  final Map<String, List<AttendanceDay>> buckets = <String, List<AttendanceDay>>{};
  final Map<String, DateTime> starts = <String, DateTime>{};
  for (final AttendanceDay day in days) {
    final DateTime local = (day.checkInAt ?? day.date).toLocal();
    final String key = CairoTime.iso(local);
    buckets.putIfAbsent(key, () => <AttendanceDay>[]).add(day);
    starts.putIfAbsent(key, () => local);
  }
  final List<String> keys = buckets.keys.toList()
    ..sort((String a, String b) => b.compareTo(a));
  return <_DayGroup>[
    for (final String key in keys) _DayGroup(date: starts[key]!, records: buckets[key]!),
  ];
}

class _HistoryList extends StatelessWidget {
  const _HistoryList({required this.groups});

  final List<_DayGroup> groups;

  @override
  Widget build(BuildContext context) {
    final List<Widget> slivers = <Widget>[];
    for (final _DayGroup group in groups) {
      slivers.add(
        SliverPersistentHeader(
          pinned: true,
          delegate: _DayHeaderDelegate(group: group),
        ),
      );
      slivers.add(
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                for (final AttendanceDay record in group.records) ...<Widget>[
                  _RecordRow(record: record),
                  const SizedBox(height: 8),
                ],
              ],
            ),
          ),
        ),
      );
    }
    return CustomScrollView(
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: slivers,
    );
  }
}

class _DayHeaderDelegate extends SliverPersistentHeaderDelegate {
  const _DayHeaderDelegate({required this.group});

  final _DayGroup group;

  static const double _height = 42;

  @override
  double get minExtent => _height;

  @override
  double get maxExtent => _height;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final Duration total = group.totalDuration;
    return Container(
      color: Theme.of(context).scaffoldBackgroundColor,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      alignment: AlignmentDirectional.centerStart,
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              CairoTime.formatDayAr(group.date),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w800,
                color: isDark ? Colors.white : TraccerTheme.inkLight,
              ),
            ),
          ),
          if (total > Duration.zero)
            Semantics(
              label: S.t('shiftDuration'),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const Icon(Icons.timer_outlined, size: 15, color: TraccerTheme.brand),
                  const SizedBox(width: 5),
                  Text(
                    CairoTime.elapsedLabel(total),
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: TraccerTheme.brand,
                    ),
                  ),
                ],
              ),
            )
          else
            const Text(
              '—',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: TraccerTheme.muted),
            ),
        ],
      ),
    );
  }

  @override
  bool shouldRebuild(covariant _DayHeaderDelegate oldDelegate) =>
      oldDelegate.group.date != group.date ||
      oldDelegate.group.records.length != group.records.length ||
      oldDelegate.group.totalDuration != group.totalDuration;
}

class _RecordRow extends StatelessWidget {
  const _RecordRow({required this.record});

  final AttendanceDay record;

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final ({String label, Color color}) status = _statusOf(record);
    final DateTime? checkIn = record.checkInAt?.toLocal();
    final DateTime? checkOut = record.checkOutAt?.toLocal();
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(TraccerTheme.cardRadius),
        boxShadow: TraccerTheme.cardShadow(isDark),
      ),
      child: Card(
        clipBehavior: Clip.antiAlias,
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: <Widget>[
                  Expanded(
                    child: _TimeCell(
                      label: S.t('in'),
                      value: checkIn == null ? '—' : CairoTime.formatTime(checkIn),
                      isDark: isDark,
                    ),
                  ),
                  Expanded(
                    child: _TimeCell(
                      label: S.t('out'),
                      value: checkOut == null ? '—' : CairoTime.formatTime(checkOut),
                      isDark: isDark,
                    ),
                  ),
                  const SizedBox(width: 8),
                  _StatusPill(label: status.label, color: status.color),
                ],
              ),
              if (record.fenceName != null) ...<Widget>[
                const SizedBox(height: 6),
                Row(
                  children: <Widget>[
                    const Icon(Icons.place_outlined, size: 13, color: TraccerTheme.muted),
                    const SizedBox(width: 5),
                    Flexible(
                      child: Text(
                        record.fenceName!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 11, color: TraccerTheme.muted),
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  static ({String label, Color color}) _statusOf(AttendanceDay record) {
    final String? status = record.status;
    if (record.exception || status == AttendanceStatus.outOfFence) {
      return (label: S.t('outsideFence'), color: TraccerTheme.amber);
    }
    if (status == AttendanceStatus.missingCheckout) {
      return (label: S.t('statusMissingCheckout'), color: TraccerTheme.red);
    }
    if (status == AttendanceStatus.autoClosed) {
      return (label: S.t('statusAutoClosed'), color: TraccerTheme.brand);
    }
    if (record.checkInAt == null) {
      return (label: S.t('statusAbsent'), color: TraccerTheme.muted);
    }
    if (record.checkOutAt == null) {
      return (label: S.t('statusOpenShift'), color: TraccerTheme.brand);
    }
    return (label: S.t('statusPresent'), color: TraccerTheme.green);
  }
}

class _TimeCell extends StatelessWidget {
  const _TimeCell({required this.label, required this.value, required this.isDark});

  final String label;
  final String value;
  final bool isDark;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: TraccerTheme.muted),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w800,
            color: isDark ? Colors.white : TraccerTheme.inkLight,
          ),
        ),
      ],
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 112),
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

class _StatePane extends StatelessWidget {
  const _StatePane({required this.icon, required this.message, this.onRetry});

  final IconData icon;
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext ctx, BoxConstraints constraints) => SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight),
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(icon, size: 44, color: TraccerTheme.muted),
                const SizedBox(height: 12),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 32),
                  child: Text(
                    message,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: TraccerTheme.muted, fontSize: 15, height: 1.4),
                  ),
                ),
                if (onRetry != null) ...<Widget>[
                  const SizedBox(height: 16),
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
          ),
        ),
      ),
    );
  }
}

class _HistorySkeleton extends StatelessWidget {
  const _HistorySkeleton();

  @override
  Widget build(BuildContext context) {
    final Color tint = TraccerTheme.brand.withValues(
      alpha: Theme.of(context).brightness == Brightness.dark ? 0.18 : 0.07,
    );
    return Semantics(
      label: S.t('loading'),
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        itemCount: 6,
        separatorBuilder: (BuildContext _, int __) => const SizedBox(height: 8),
        itemBuilder: (BuildContext _, int index) => index.isEven
            ? Align(
                alignment: AlignmentDirectional.centerStart,
                child: Container(height: 13, width: 150, decoration: _block(tint)),
              )
            : Card(
                clipBehavior: Clip.antiAlias,
                margin: EdgeInsets.zero,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                  child: Row(
                    children: <Widget>[
                      Expanded(child: Container(height: 20, decoration: _block(tint))),
                      const SizedBox(width: 10),
                      Expanded(child: Container(height: 20, decoration: _block(tint))),
                      const SizedBox(width: 10),
                      Container(width: 72, height: 24, decoration: _block(tint)),
                    ],
                  ),
                ),
              ),
      ),
    );
  }

  static BoxDecoration _block(Color tint) => BoxDecoration(
        color: tint,
        borderRadius: BorderRadius.circular(6),
      );
}
