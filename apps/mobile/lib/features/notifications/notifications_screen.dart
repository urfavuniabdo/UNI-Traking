import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/api_error.dart';
import '../../core/app_strings.dart';
import '../../core/cairo_time.dart';
import '../../core/traccer_constants.dart';
import '../../models/alert.dart';
import '../../state/providers.dart';
import '../../theme.dart';

/// Own alert list (`GET /alerts`, scoped to `/me` server-side, §6). Drivers only see the
/// types in `DRIVER_VISIBLE_ALERTS`; a tap expands the alert inline — never a dialog, never a chat.
class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  late Future<List<TraccerAlert>> _future;
  final Set<String> _expanded = <String>{};
  final Set<String> _seen = <String>{};

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<TraccerAlert>> _load() async {
    final ApiClient api = ref.read(apiClientProvider);
    final bool driver = ref.read(sessionStoreProvider).user?.isDriver ?? false;
    final List<TraccerAlert> all = await api.myAlerts();
    final List<TraccerAlert> visible = driver
        ? all.where((TraccerAlert a) => DriverVisibleAlerts.all.contains(a.type)).toList()
        : List<TraccerAlert>.of(all);
    visible.sort((TraccerAlert a, TraccerAlert b) => b.createdAt.compareTo(a.createdAt));
    return visible;
  }

  Future<void> _reload() async {
    final Future<List<TraccerAlert>> next = _load();
    setState(() => _future = next);
    await next.catchError((Object _) => const <TraccerAlert>[]);
  }

  void _toggle(String key) {
    setState(() {
      _seen.add(key);
      if (!_expanded.remove(key)) _expanded.add(key);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(S.t('notifications'))),
      body: RefreshIndicator(
        onRefresh: _reload,
        color: TraccerTheme.brand,
        child: Semantics(
          label: S.t('pullToRefresh'),
          child: FutureBuilder<List<TraccerAlert>>(
            future: _future,
            builder: (BuildContext _, AsyncSnapshot<List<TraccerAlert>> snap) => _buildBody(snap),
          ),
        ),
      ),
    );
  }

  Widget _buildBody(AsyncSnapshot<List<TraccerAlert>> snap) {
    if (snap.connectionState == ConnectionState.waiting) {
      return const _NotificationsSkeleton();
    }
    if (snap.hasError) {
      final Object? error = snap.error;
      return _StatePane(
        icon: Icons.cloud_off,
        message: error is ApiException ? error.message : S.t('noConnection'),
        onRetry: _reload,
      );
    }
    final List<TraccerAlert> alerts = snap.data ?? const <TraccerAlert>[];
    if (alerts.isEmpty) {
      return _StatePane(icon: Icons.notifications_none, message: S.t('notificationsEmpty'));
    }
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      itemCount: alerts.length,
      separatorBuilder: (BuildContext _, int __) => const SizedBox(height: 8),
      itemBuilder: (BuildContext _, int index) {
        final TraccerAlert alert = alerts[index];
        final String key = alert.id.isNotEmpty ? alert.id : '#$index';
        return _AlertRow(
          alert: alert,
          expanded: _expanded.contains(key),
          unread: alert.status == 'OPEN' && !_seen.contains(key),
          onTap: () => _toggle(key),
        );
      },
    );
  }
}

class _AlertRow extends StatelessWidget {
  const _AlertRow({
    required this.alert,
    required this.expanded,
    required this.unread,
    required this.onTap,
  });

  final TraccerAlert alert;
  final bool expanded;
  final bool unread;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final bool isDark = Theme.of(context).brightness == Brightness.dark;
    final Color color = _typeColor(alert);
    final DateTime created = alert.createdAt.toLocal();
    final Color ink = isDark ? Colors.white : TraccerTheme.inkLight;
    final ({String label, Color color}) state = _stateOf(alert);
    final String? typeLabel = ArAlertText.byType[alert.type]?.title;
    final double? lat = alert.lat;
    final double? lng = alert.lng;
    final DateTime? ackAt = alert.ackAt;

    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(TraccerTheme.cardRadius),
        boxShadow: TraccerTheme.cardShadow(isDark),
      ),
      child: Card(
        clipBehavior: Clip.antiAlias,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(TraccerTheme.cardRadius),
          side: BorderSide(
            color: unread
                ? color.withValues(alpha: 0.55)
                : TraccerTheme.brand.withValues(alpha: isDark ? 0.25 : 0.12),
          ),
        ),
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Icon(
                      unread ? Icons.circle : Icons.radio_button_unchecked,
                      size: 10,
                      color: unread ? color : color.withValues(alpha: 0.55),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        alert.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: unread ? FontWeight.w800 : FontWeight.w500,
                          color: unread ? ink : TraccerTheme.muted,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Padding(
                  padding: const EdgeInsetsDirectional.only(start: 18),
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: Text(
                          '${CairoTime.formatDayAr(created)} · ${CairoTime.formatTime(created)}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: unread ? FontWeight.w700 : FontWeight.w500,
                            color: unread ? ink : TraccerTheme.muted,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      _StatusPill(label: state.label, color: state.color),
                      const SizedBox(width: 4),
                      Icon(
                        expanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
                        size: 18,
                        color: TraccerTheme.muted,
                      ),
                    ],
                  ),
                ),
                AnimatedSize(
                  duration: const Duration(milliseconds: 180),
                  curve: Curves.easeOut,
                  alignment: AlignmentDirectional.topStart,
                  child: expanded
                      ? Padding(
                          padding: const EdgeInsetsDirectional.only(start: 18, top: 8),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Text(
                                alert.body,
                                style: TextStyle(
                                  fontSize: 13,
                                  height: 1.45,
                                  color: isDark ? Colors.white70 : TraccerTheme.inkLight,
                                ),
                              ),
                              if (typeLabel != null && typeLabel != alert.title) ...<Widget>[
                                const SizedBox(height: 8),
                                Row(
                                  children: <Widget>[
                                    Icon(Icons.label_outline, size: 14, color: color),
                                    const SizedBox(width: 5),
                                    Flexible(
                                      child: Text(
                                        typeLabel,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: TextStyle(
                                          fontSize: 11,
                                          fontWeight: FontWeight.w700,
                                          color: color,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ],
                              if (ackAt != null) ...<Widget>[
                                const SizedBox(height: 4),
                                Text(
                                  '${S.t('alertHandledAt')} ${CairoTime.formatDayAr(ackAt.toLocal())} · '
                                  '${CairoTime.formatTime(ackAt.toLocal())}',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                    color: TraccerTheme.green,
                                  ),
                                ),
                              ],
                              if (lat != null && lng != null) ...<Widget>[
                                const SizedBox(height: 4),
                                Directionality(
                                  textDirection: TextDirection.ltr,
                                  child: Text(
                                    '${lat.toStringAsFixed(5)}, ${lng.toStringAsFixed(5)}',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 11, color: TraccerTheme.muted),
                                  ),
                                ),
                              ],
                            ],
                          ),
                        )
                      : const SizedBox(width: double.infinity),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  static Color _typeColor(TraccerAlert alert) {
    final Color? byType = switch (alert.type) {
      'GEOFENCE_ENTER' || 'BUFFER_REPLAYED' => TraccerTheme.green,
      'GEOFENCE_EXIT' ||
      'CHECK_IN_OUT_OF_FENCE' ||
      'CHECKOUT_MISSING' ||
      'STOP_EXCEEDED' ||
      'ROUTE_GAP' ||
      'IDLE_LONG' ||
      'GPS_OFF' ||
      'DATA_OFF' =>
        TraccerTheme.amber,
      'SPEEDING' ||
      'HARSH_BRAKING' ||
      'HARSH_ACCELERATION' ||
      'APP_OFFLINE' ||
      'HEARTBEAT_MISSING' =>
        TraccerTheme.red,
      _ => null,
    };
    return byType ??
        switch (alert.severity) {
          'CRITICAL' => TraccerTheme.red,
          'WARNING' => TraccerTheme.amber,
          _ => TraccerTheme.brand,
        };
  }

  static ({String label, Color color}) _stateOf(TraccerAlert alert) => switch (alert.status) {
        'RESOLVED' => (label: S.t('alertResolvedStatus'), color: TraccerTheme.green),
        'ACK' => (label: S.t('alertAckStatus'), color: TraccerTheme.amber),
        _ => (label: S.t('alertOpenStatus'), color: TraccerTheme.brand),
      };
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 104),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: color),
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
      builder: (BuildContext _, BoxConstraints constraints) => SingleChildScrollView(
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

class _NotificationsSkeleton extends StatelessWidget {
  const _NotificationsSkeleton();

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
        itemBuilder: (BuildContext _, int index) => Card(
          clipBehavior: Clip.antiAlias,
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Icon(Icons.circle, size: 10, color: tint),
                    const SizedBox(width: 8),
                    Expanded(child: Container(height: 13, decoration: _block(tint))),
                    const SizedBox(width: 8),
                    Container(width: index.isEven ? 74 : 58, height: 20, decoration: _block(tint)),
                  ],
                ),
                const SizedBox(height: 8),
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: Container(height: 10, width: 130, decoration: _block(tint)),
                ),
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
