import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/cairo_time.dart';
import '../../core/api_client.dart';
import '../../core/app_strings.dart';
import '../../core/traccer_constants.dart';
import '../../models/alert.dart';
import '../../state/providers.dart';
import '../../theme.dart';

/// Own alert list (`GET /alerts`, scoped to `/me` server-side, §6). Drivers only see the
/// types in `DRIVER_VISIBLE_ALERTS`; tap opens nothing but the app itself (never a chat).
class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  late Future<List<TraccerAlert>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<TraccerAlert>> _load() async {
    final ApiClient api = ref.read(apiClientProvider);
    final bool driver = ref.read(sessionStoreProvider).user?.isDriver ?? false;
    try {
      final List<TraccerAlert> all = await api.myAlerts();
      return driver
          ? all.where((TraccerAlert a) => DriverVisibleAlerts.all.contains(a.type)).toList()
          : all;
    } catch (_) {
      return <TraccerAlert>[];
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(S.t('notifications'))),
      body: FutureBuilder<List<TraccerAlert>>(
        future: _future,
        builder: (BuildContext ctx, AsyncSnapshot<List<TraccerAlert>> snap) {
          if (snap.isLoading) return const Center(child: CircularProgressIndicator());
          final List<TraccerAlert> alerts = snap.data ?? const <TraccerAlert>[];
          if (alerts.isEmpty) {
            return Center(child: Text(S.t('notificationsEmpty'), style: const TextStyle(color: TraccerTheme.muted)));
          }
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: alerts.length,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (_, int i) {
              final TraccerAlert a = alerts[i];
              return Card(
                child: ListTile(
                  leading: Icon(Icons.warning_amber_rounded, color: _sevColor(a.severity)),
                  title: Text(a.title, style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text('${a.body}\n${CairoTime.formatDayAr(a.createdAt.toLocal())}'),
                  isThreeLine: true,
                ),
              );
            },
          );
        },
      ),
    );
  }

  Color _sevColor(String severity) => switch (severity) {
        'CRITICAL' => TraccerTheme.red,
        'WARNING' => TraccerTheme.amber,
        _ => TraccerTheme.brand,
      };
}
