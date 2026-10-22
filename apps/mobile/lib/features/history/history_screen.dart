import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/cairo_time.dart';
import '../../core/api_client.dart';
import '../../core/app_strings.dart';
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
  late Future<List<AttendanceDay>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<AttendanceDay>> _load() async {
    final ApiClient api = ref.read(apiClientProvider);
    final DateTime now = DateTime.now();
    try {
      return await api.history(from: now.subtract(const Duration(days: 30)), to: now);
    } catch (_) {
      return <AttendanceDay>[];
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(S.t('history'))),
      body: FutureBuilder<List<AttendanceDay>>(
        future: _future,
        builder: (BuildContext ctx, AsyncSnapshot<List<AttendanceDay>> snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          final List<AttendanceDay> days = snap.data ?? const <AttendanceDay>[];
          if (days.isEmpty) {
            return Center(child: Text(S.t('historyEmpty'), style: const TextStyle(color: TraccerTheme.muted)));
          }
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: days.length,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (_, int i) {
              final AttendanceDay d = days[i];
              return Card(
                child: ListTile(
                  title: Text(CairoTime.formatDayAr(d.date)),
                  subtitle: Text(
                    '${S.t('inTime')}: ${d.checkInAt != null ? CairoTime.formatTime(d.checkInAt!) : '—'}'
                    '  |  ${S.t('outTime')}: ${d.checkOutAt != null ? CairoTime.formatTime(d.checkOutAt!) : '—'}',
                  ),
                  trailing: d.exception
                      ? const Chip(
                          label: Text('استثناء'),
                          backgroundColor: Color(0x22F59E0B),
                          side: BorderSide(color: TraccerTheme.amber),
                        )
                      : null,
                ),
              );
            },
          );
        },
      ),
    );
  }
}
