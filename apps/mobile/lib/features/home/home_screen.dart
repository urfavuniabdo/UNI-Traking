import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_error.dart';
import '../../core/app_strings.dart';
import '../../core/cairo_time.dart';
import '../../core/traccer_constants.dart';
import '../../state/providers.dart';
import '../../theme.dart';
import '../settings/settings_sheet.dart';

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  bool _dialogShown = false;

  @override
  Widget build(BuildContext context) {
    final HomeState home = ref.watch(homeControllerProvider);
    final AuthState auth = ref.watch(authControllerProvider);
    final bool isDark = Theme.of(context).brightness == Brightness.dark;

    // Show the hard fence-rejection dialog exactly once per violation.
    ref.listen<HomeState>(homeControllerProvider, (HomeState? prev, HomeState next) {
      if (next.fenceViolation != null && !_dialogShown) {
        _dialogShown = true;
        _showFenceViolation(next.fenceViolation!);
      }
      if (next.fenceViolation == null) _dialogShown = false;
    });

    return Scaffold(
      appBar: AppBar(
        title: Text(S.t('appName')),
        actions: <Widget>[
          IconButton(
            tooltip: S.t('history'),
            icon: const Icon(Icons.event_note),
            onPressed: () => context.push('/history'),
          ),
          IconButton(
            tooltip: S.t('notifications'),
            icon: const Icon(Icons.notifications_none),
            onPressed: () => context.push('/me/notifications'),
          ),
          IconButton(
            tooltip: S.t('settings'),
            icon: const Icon(Icons.tune),
            onPressed: () => showSettingsSheet(context, ref),
          ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              _StatusCard(home: home, isDark: isDark, user: auth.user?.name ?? ''),
              if (home.amberOutOfFence) ...<Widget>[
                const SizedBox(height: 12),
                _AmberNotice(message: S.t('outOfFenceNotice')),
              ],
              const SizedBox(height: 20),
              _AutoIndicators(home: home),
              const SizedBox(height: 20),
              if (home.tracking) _EmergencyStop(onHold: _emergencyStop),
              const SizedBox(height: 24),
              Text(
                S.t('automatic'),
                textAlign: TextAlign.center,
                style: const TextStyle(color: TraccerTheme.muted),
              ),
              const SizedBox(height: 12),
              _CheckButton(home: home, onCheckIn: ref.read(homeControllerProvider.notifier).checkIn,
                  onCheckOut: ref.read(homeControllerProvider.notifier).checkOut),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _emergencyStop() async {
    await ref.read(homeControllerProvider.notifier).emergencyStopTracking();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(S.t('stoppedEmergency'))));
  }

  void _showFenceViolation(FenceViolationException e) {
    showModalBottomSheet<void>(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (BuildContext ctx) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Icon(Icons.warning_amber_rounded, color: TraccerTheme.red, size: 40),
            const SizedBox(height: 12),
            Text('فشل التشيك ان — خارج النطاق',
                style: Theme.of(ctx).textTheme.titleLarge),
            const SizedBox(height: 8),
            if (e.fenceName != null) Text('${S.t('fence')}: ${e.fenceName}'),
            if (e.distanceToCenterM != null)
              Text('${S.t('distanceToCenter')}: ${e.distanceToCenterM!.toStringAsFixed(0)} ${S.t('meters')}'),
            if (e.allowedFences.isNotEmpty) ...<Widget>[
              const SizedBox(height: 8),
              Text('النطاقات المسموحة: ${e.allowedFences.join('، ')}'),
            ],
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: () {
                ref.read(homeControllerProvider.notifier).dismissFenceViolation();
                Navigator.of(ctx).pop();
              },
              icon: const Icon(Icons.call),
              label: Text(S.t('contactSupervisor')),
            ),
          ],
        ),
      ),
    );
  }
}

/// The big live card: fence state + shift clock + the ONE button lives below it.
class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.home, required this.isDark, required this.user});
  final HomeState home;
  final bool isDark;
  final String user;

  @override
  Widget build(BuildContext context) {
    final Color fenceColor = home.insideFence == null
        ? TraccerTheme.muted
        : (home.insideFence! ? TraccerTheme.green : TraccerTheme.amber);
    final String fenceText = home.insideFence == null
        ? S.t('fenceUnknown')
        : (home.insideFence! ? S.t('insideFence') : S.t('outsideFence'));

    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(TraccerTheme.cardRadius),
        side: BorderSide(color: TraccerTheme.brand.withOpacity(isDark ? 0.25 : 0.12)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text('مرحبًا $user', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 16),
            Row(
              children: <Widget>[
                Icon(Icons.circle, color: fenceColor, size: 14),
                const SizedBox(width: 8),
                Text(fenceText,
                    style: TextStyle(color: fenceColor, fontWeight: FontWeight.w800, fontSize: 20)),
                const Spacer(),
                if (home.motionState != null)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    decoration: BoxDecoration(
                      color: TraccerTheme.brand.withOpacity(0.10),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      MotionStates.ar[home.motionState] ?? '',
                      style: const TextStyle(color: TraccerTheme.brand, fontWeight: FontWeight.w700),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 20),
            Row(
              children: <Widget>[
                const Icon(Icons.schedule, color: TraccerTheme.muted),
                const SizedBox(width: 8),
                Text(
                  home.checkedIn && home.shiftStart != null
                      ? '${S.t('shiftTime')}: ${CairoTime.formatTime(home.shiftStart!)} — '
                          '${CairoTime.elapsedLabel(DateTime.now().difference(home.shiftStart!))}'
                      : S.t('noShift'),
                  style: const TextStyle(fontSize: 15),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// THE pill button: تشيك ان ⇄ تشيك أوت. Nothing else triggers actions.
class _CheckButton extends StatelessWidget {
  const _CheckButton({required this.home, required this.onCheckIn, required this.onCheckOut});
  final HomeState home;
  final Future<void> Function() onCheckIn;
  final Future<void> Function() onCheckOut;

  @override
  Widget build(BuildContext context) {
    final bool checkedIn = home.checkedIn;
    return FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: checkedIn ? TraccerTheme.brandDark : TraccerTheme.brand,
      ),
      onPressed: home.busy ? null : (checkedIn ? onCheckOut : onCheckIn),
      child: home.busy
          ? const SizedBox(height: 26, width: 26, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
          : Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Icon(checkedIn ? Icons.logout : Icons.login, color: Colors.white),
                const SizedBox(width: 12),
                Text(checkedIn ? S.t('checkOut') : S.t('checkIn')),
              ],
            ),
    );
  }
}

/// Read-only automatic indicators — no controls (except the documented emergency stop below).
class _AutoIndicators extends StatelessWidget {
  const _AutoIndicators({required this.home});
  final HomeState home;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Column(
          children: <Widget>[
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: const <Widget>[
                Text('مؤشرات تلقائية', style: TextStyle(color: TraccerTheme.muted)),
                Icon(Icons.info_outline, color: TraccerTheme.muted, size: 18),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                _chip(context, home.tracking, S.t('trackingWorking'), S.t('trackingStopped'),
                    home.tracking ? TraccerTheme.green : TraccerTheme.red),
                _chip(context, true, S.t('gpsOn'), S.t('gpsOff'),
                    home.gpsEnabled ? TraccerTheme.green : TraccerTheme.red),
                _chip(context, true, S.t('dataConnected'), S.t('dataOffline'),
                    home.online ? TraccerTheme.green : TraccerTheme.amber),
                _offlineChip(context, home.pendingCount),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _chip(BuildContext ctx, bool _, String on, String off, Color color) {
    final String label = color == TraccerTheme.red || color == TraccerTheme.amber ? off : on;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: color.withOpacity(0.10),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.circle, size: 8, color: color),
          const SizedBox(width: 6),
          Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }

  Widget _offlineChip(BuildContext ctx, int pending) {
    final bool hasBacklog = pending > 0;
    final Color color = hasBacklog ? TraccerTheme.amber : TraccerTheme.green;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: color.withOpacity(0.10),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        '${S.t('offlineBuffer')}: ${pending > 0 ? '$pending ${S.t('points')}' : '0'}',
        style: TextStyle(color: color, fontWeight: FontWeight.w700),
      ),
    );
  }
}

class _AmberNotice extends StatelessWidget {
  const _AmberNotice({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: TraccerTheme.amber.withOpacity(0.14),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: TraccerTheme.amber.withOpacity(0.5)),
        ),
        child: Row(children: <Widget>[
          const Icon(Icons.report_gmailerrorred, color: TraccerTheme.amber),
          const SizedBox(width: 10),
          Expanded(child: Text(message, style: const TextStyle(fontWeight: FontWeight.w600))),
        ]),
      );
}

/// Documented emergency "إيقاف التتبع" — requires a 3s hold, then alerts admins.
class _EmergencyStop extends StatefulWidget {
  const _EmergencyStop({required this.onHold});
  final Future<void> Function() onHold;
  @override
  State<_EmergencyStop> createState() => _EmergencyStopState();
}

class _EmergencyStopState extends State<_EmergencyStop> {
  Timer? _timer;
  double _progress = 0;

  void _startHold() {
    const int totalMs = 3000;
    const int step = 50;
    setState(() => _progress = 0);
    _timer = Timer.periodic(const Duration(milliseconds: step), (Timer t) {
      setState(() => _progress += step / totalMs);
      if (_progress >= 1) {
        t.cancel();
        widget.onHold();
      }
    });
  }

  void _cancelHold() {
    _timer?.cancel();
    setState(() => _progress = 0);
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onLongPressStart: (_) => _startHold(),
      onLongPressEnd: (_) => _cancelHold(),
      onLongPressCancel: () => _cancelHold(),
      child: Stack(
        alignment: Alignment.center,
        children: <Widget>[
          SizedBox(
            height: 48,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: TraccerTheme.red.withOpacity(0.12),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: FractionallySizedBox(
                  widthFactor: _progress.clamp(0.0, 1.0),
                  child: Container(
                    decoration: BoxDecoration(
                      color: TraccerTheme.red.withOpacity(0.35),
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Text(
            S.t('holdToStop'),
            style: const TextStyle(color: TraccerTheme.red, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }
}
