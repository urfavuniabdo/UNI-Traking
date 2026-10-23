import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher_string.dart';

import '../../core/api_error.dart';
import '../../core/app_strings.dart';
import '../../core/cairo_time.dart';
import '../../core/traccer_constants.dart';
import '../../state/providers.dart';
import '../../theme.dart';
import '../settings/settings_sheet.dart';

/// Semantic colours are dark enough for the light surface; on the dark surface
/// (#0B1220) they get lifted towards white so text stays legible.
Color _legible(Color color, bool dark) => dark ? Color.lerp(color, Colors.white, 0.32)! : color;

Color _inkOf(BuildContext context) => Theme.of(context).brightness == Brightness.dark
    ? Colors.white
    : TraccerTheme.inkLight;

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
    final bool isDriver = auth.user?.isDriver ?? false;
    final HomeController controller = ref.read(homeControllerProvider.notifier);

    // Show the hard fence-rejection dialog exactly once per violation.
    ref.listen<HomeState>(homeControllerProvider, (HomeState? prev, HomeState next) {
      if (next.fenceViolation != null && !_dialogShown) {
        _dialogShown = true;
        _showFenceViolation(next.fenceViolation!);
      }
      if (next.fenceViolation == null) {
        _dialogShown = false;
      }
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
            tooltip: S.t('leaveRequests'),
            icon: const Icon(Icons.beach_access_outlined),
            onPressed: () => context.push('/leave'),
          ),
          IconButton(
            tooltip: S.t('notifications'),
            icon: const Icon(Icons.notifications_none),
            onPressed: () => context.push('/me/notifications'),
          ),
          IconButton(
            tooltip: S.t('settings'),
            icon: const Icon(Icons.tune),
            onPressed: () => showSettingsSheet(context),
          ),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  _StatusCard(home: home, isDark: isDark, user: auth.user?.name ?? ''),
                  if (home.notice != null) ...<Widget>[
                    const SizedBox(height: 10),
                    _AmberNotice(
                      message: home.notice!,
                      isDark: isDark,
                      onDismiss: controller.dismissNotice,
                    ),
                  ],
                  if (home.amberOutOfFence) ...<Widget>[
                    const SizedBox(height: 10),
                    _AmberNotice(message: S.t('outOfFenceNotice'), isDark: isDark),
                  ],
                  const SizedBox(height: 10),
                  _AutoIndicators(home: home, isDriver: isDriver, isDark: isDark),
                  if (home.tracking) ...<Widget>[
                    const SizedBox(height: 10),
                    _EmergencyStop(onHold: _emergencyStop, isDark: isDark),
                  ],
                  const SizedBox(height: 14),
                  Text(
                    S.t('automatic'),
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: _legible(TraccerTheme.muted, isDark),
                      fontSize: 13,
                      height: 1.4,
                    ),
                  ),
                ],
              ),
            ),
          ),
          _BottomBar(
            home: home,
            isDark: isDark,
            onCheckIn: controller.checkIn,
            onCheckOut: controller.checkOut,
          ),
        ],
      ),
    );
  }

  Future<void> _emergencyStop() async {
    await ref.read(homeControllerProvider.notifier).emergencyStopTracking();
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(S.t('stoppedEmergency'))));
  }

  void _showFenceViolation(FenceViolationException e) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (BuildContext ctx) {
        final bool dark = Theme.of(ctx).brightness == Brightness.dark;
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 10, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: TraccerTheme.brand.withValues(alpha: dark ? 0.35 : 0.25),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              Row(
                children: <Widget>[
                  Icon(Icons.warning_amber_rounded, color: _legible(TraccerTheme.red, dark), size: 28),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      S.t('fenceCheckInFailed'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                        color: _inkOf(ctx),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              if (e.fenceName != null) _DetailLine(label: S.t('fence'), value: e.fenceName!),
              if (e.distanceToCenterM != null)
                _DetailLine(
                  label: S.t('distanceToCenter'),
                  value: '${e.distanceToCenterM!.toStringAsFixed(0)} ${S.t('meters')}',
                ),
              if (e.allowedFences.isNotEmpty)
                _DetailLine(label: S.t('allowedFencesLabel'), value: e.allowedFences.join('، ')),
              const SizedBox(height: 18),
              FilledButton.icon(
                onPressed: () async {
                  ref.read(homeControllerProvider.notifier).dismissFenceViolation();
                  if (ctx.mounted) {
                    Navigator.of(ctx).pop();
                  }
                  final String? phone = e.supervisorPhone;
                  if (phone != null && phone.isNotEmpty) {
                    try {
                      await launchUrlString('tel:$phone', mode: LaunchMode.externalApplication);
                    } catch (_) {/* no dialer — the alert already reached admins */}
                  }
                },
                icon: const Icon(Icons.call),
                label: Text(S.t('contactSupervisor')),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Compact card for a read-only value pair inside the fence-violation sheet.
class _DetailLine extends StatelessWidget {
  const _DetailLine({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final bool dark = Theme.of(context).brightness == Brightness.dark;
    final TextStyle base = TextStyle(fontSize: 14, color: _inkOf(context));
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text.rich(
        TextSpan(
          children: <InlineSpan>[
            TextSpan(
              text: '$label: ',
              style: base.copyWith(color: _legible(TraccerTheme.muted, dark)),
            ),
            TextSpan(text: value, style: base.copyWith(fontWeight: FontWeight.w700)),
          ],
        ),
      ),
    );
  }
}

/// Brand-bordered panel used by every card on the screen.
class _Panel extends StatelessWidget {
  const _Panel({
    required this.isDark,
    required this.child,
    this.padding = const EdgeInsets.all(16),
  });
  final bool isDark;
  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final Color cardColor =
        Theme.of(context).cardTheme.color ?? Theme.of(context).colorScheme.surface;
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: cardColor,
        borderRadius: BorderRadius.circular(TraccerTheme.cardRadius),
        border: Border.all(color: TraccerTheme.brand.withValues(alpha: isDark ? 0.28 : 0.14)),
        boxShadow: TraccerTheme.cardShadow(isDark),
      ),
      child: child,
    );
  }
}

/// Small rounded, content-sized tag. Colour always follows the boolean state.
class _Tag extends StatelessWidget {
  const _Tag({
    required this.label,
    required this.color,
    required this.isDark,
    this.withDot = true,
  });
  final String label;
  final Color color;
  final bool isDark;
  final bool withDot;

  @override
  Widget build(BuildContext context) {
    final Color ink = _legible(color, isDark);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: isDark ? 0.18 : 0.10),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (withDot) ...<Widget>[
            Icon(Icons.circle, size: 7, color: ink),
            const SizedBox(width: 6),
          ],
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: ink, fontWeight: FontWeight.w700, fontSize: 12.5),
            ),
          ),
        ],
      ),
    );
  }
}

/// The live status card: fence state, motion pill and the shift clock.
class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.home, required this.isDark, required this.user});
  final HomeState home;
  final bool isDark;
  final String user;

  @override
  Widget build(BuildContext context) {
    final bool? insideFence = home.insideFence;
    final Color fenceColor = insideFence == null
        ? TraccerTheme.muted
        : (insideFence ? TraccerTheme.green : TraccerTheme.amber);
    final String fenceText = insideFence == null
        ? S.t('fenceUnknown')
        : (insideFence ? S.t('insideFence') : S.t('outsideFence'));
    final String motionLabel = MotionStates.ar[home.motionState] ?? '';
    final bool onLeave = home.onLeave && !home.checkedIn;
    final String shiftText = onLeave
        ? S.t('leaveTodayStatus')
        : home.checkedIn && home.shiftStart != null
            ? '${S.t('shiftTime')}: ${CairoTime.formatTime(home.shiftStart!)} — '
                '${CairoTime.elapsedLabel(DateTime.now().difference(home.shiftStart!))}'
            : S.t('noShift');

    return _Panel(
      isDark: isDark,
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            '${S.t('greeting')} $user',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          Row(
            children: <Widget>[
              Icon(Icons.circle, color: _legible(fenceColor, isDark), size: 12),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  fenceText,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: _legible(fenceColor, isDark),
                    fontWeight: FontWeight.w800,
                    fontSize: 18,
                  ),
                ),
              ),
              if (motionLabel.isNotEmpty) ...<Widget>[
                const SizedBox(width: 8),
                _Tag(label: motionLabel, color: TraccerTheme.brand, isDark: isDark, withDot: false),
              ],
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: <Widget>[
              Icon(
                onLeave ? Icons.event_available : Icons.schedule,
                size: 16,
                color: onLeave ? _legible(TraccerTheme.leave, isDark) : _legible(TraccerTheme.muted, isDark),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  shiftText,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14,
                    color: onLeave ? _legible(TraccerTheme.leave, isDark) : _inkOf(context),
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// THE pill button: بدء اليوم ⇄ إنهاء اليوم. The only action on this screen.
class _CheckButton extends StatelessWidget {
  const _CheckButton({
    required this.home,
    required this.onCheckIn,
    required this.onCheckOut,
  });
  final HomeState home;
  final Future<void> Function() onCheckIn;
  final Future<void> Function() onCheckOut;

  @override
  Widget build(BuildContext context) {
    final bool checkedIn = home.checkedIn;
    // An approved leave day is already accounted for — the CTA goes inert, it doesn't lie.
    final bool locked = home.onLeave && !checkedIn;
    if (locked) {
      return FilledButton(
        style: FilledButton.styleFrom(
          backgroundColor: TraccerTheme.leave.withValues(alpha: 0.16),
          foregroundColor: TraccerTheme.leave,
        ),
        onPressed: null,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            const Icon(Icons.event_available),
            const SizedBox(width: 12),
            Flexible(
              child: Text(S.t('leaveTodayButton'), maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
          ],
        ),
      );
    }
    return FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: checkedIn ? TraccerTheme.brandDark : TraccerTheme.brand,
      ),
      onPressed: home.busy ? null : (checkedIn ? onCheckOut : onCheckIn),
      child: home.busy
          ? const SizedBox(
              height: 26,
              width: 26,
              child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white),
            )
          : Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Icon(checkedIn ? Icons.logout : Icons.login, color: Colors.white),
                const SizedBox(width: 12),
                Flexible(
                  child: Text(
                    checkedIn ? S.t('checkOut') : S.t('checkIn'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
    );
  }
}

/// Pinned CTA bar: the button hugs the bottom edge, only the area above scrolls.
class _BottomBar extends StatelessWidget {
  const _BottomBar({
    required this.home,
    required this.isDark,
    required this.onCheckIn,
    required this.onCheckOut,
  });
  final HomeState home;
  final bool isDark;
  final Future<void> Function() onCheckIn;
  final Future<void> Function() onCheckOut;

  @override
  Widget build(BuildContext context) {
    final Color barColor = Theme.of(context).cardTheme.color ?? Theme.of(context).colorScheme.surface;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: barColor,
        border: Border(
          top: BorderSide(color: TraccerTheme.brand.withValues(alpha: isDark ? 0.30 : 0.14)),
        ),
      ),
      child: SafeArea(
        top: false,
        minimum: const EdgeInsets.only(bottom: 8),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
          child: _CheckButton(
            home: home,
            onCheckIn: onCheckIn,
            onCheckOut: onCheckOut,
          ),
        ),
      ),
    );
  }
}

/// Read-only automatic indicators — no controls (except the documented emergency stop).
class _AutoIndicators extends StatelessWidget {
  const _AutoIndicators({required this.home, required this.isDriver, required this.isDark});
  final HomeState home;
  final bool isDriver;
  final bool isDark;

  @override
  Widget build(BuildContext context) {
    return _Panel(
      isDark: isDark,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  S.t('autoIndicators'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: _legible(TraccerTheme.muted, isDark),
                    fontWeight: FontWeight.w700,
                    fontSize: 13,
                  ),
                ),
              ),
              Icon(Icons.info_outline, size: 18, color: _legible(TraccerTheme.muted, isDark)),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              if (isDriver)
                _Tag(
                  label: _trackingLabel(),
                  color: _trackingColor(),
                  isDark: isDark,
                ),
              _stateChip(
                active: home.gpsEnabled,
                onLabel: S.t('gpsOn'),
                offLabel: S.t('gpsOff'),
                offColor: TraccerTheme.red,
              ),
              _stateChip(
                active: home.online,
                onLabel: S.t('dataConnected'),
                offLabel: S.t('dataOffline'),
                offColor: TraccerTheme.amber,
              ),
              if (isDriver)
                _Tag(
                  label: '${S.t('offlineBuffer')}: '
                      '${home.pendingCount > 0 ? '${home.pendingCount} ${S.t('points')}' : '0'}',
                  color: home.pendingCount > 0 ? TraccerTheme.amber : TraccerTheme.green,
                  isDark: isDark,
                  withDot: false,
                ),
            ],
          ),
        ],
      ),
    );
  }

  String _trackingLabel() {
    if (home.tracking) {
      return S.t('trackingWorking');
    }
    if (!home.checkedIn) {
      return S.t('trackingIdle');
    }
    return S.t('trackingStopped');
  }

  Color _trackingColor() {
    if (home.tracking) {
      return TraccerTheme.green;
    }
    if (!home.checkedIn) {
      return TraccerTheme.muted;
    }
    return TraccerTheme.red;
  }

  Widget _stateChip({
    required bool active,
    required String onLabel,
    required String offLabel,
    required Color offColor,
  }) =>
      _Tag(
        label: active ? onLabel : offLabel,
        color: active ? TraccerTheme.green : offColor,
        isDark: isDark,
      );
}

class _AmberNotice extends StatelessWidget {
  const _AmberNotice({required this.message, required this.isDark, this.onDismiss});
  final String message;
  final bool isDark;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final Color ink = _legible(TraccerTheme.amber, isDark);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: TraccerTheme.amber.withValues(alpha: isDark ? 0.18 : 0.12),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: TraccerTheme.amber.withValues(alpha: 0.45)),
      ),
      child: Row(
        children: <Widget>[
          Icon(Icons.report_gmailerrorred, color: ink, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: ink, fontWeight: FontWeight.w600, fontSize: 13),
            ),
          ),
          if (onDismiss != null)
            IconButton(
              tooltip: S.t('dismiss'),
              visualDensity: VisualDensity.compact,
              icon: Icon(Icons.close, color: ink, size: 18),
              onPressed: onDismiss,
            ),
        ],
      ),
    );
  }
}

/// Documented emergency "إيقاف التتبع" — requires a 3s hold, then alerts admins.
class _EmergencyStop extends StatefulWidget {
  const _EmergencyStop({required this.onHold, required this.isDark});
  final Future<void> Function() onHold;
  final bool isDark;

  @override
  State<_EmergencyStop> createState() => _EmergencyStopState();
}

class _EmergencyStopState extends State<_EmergencyStop> {
  static const int _totalMs = 3000;
  static const int _stepMs = 50;

  Timer? _timer;
  double _progress = 0;

  void _startHold() {
    _timer?.cancel();
    setState(() => _progress = 0);
    _timer = Timer.periodic(const Duration(milliseconds: _stepMs), (Timer t) {
      final double next = _progress + _stepMs / _totalMs;
      setState(() => _progress = next >= 1 ? 1 : next);
      if (_progress >= 1) {
        t.cancel();
        _timer = null;
        unawaited(widget.onHold());
      }
    });
  }

  void _cancelHold() {
    _timer?.cancel();
    _timer = null;
    if (mounted) {
      setState(() => _progress = 0);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Color ink = _legible(TraccerTheme.red, widget.isDark);
    return Semantics(
      label: '${S.t('emergencyStop')} — ${S.t('holdToStop')}',
      button: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onLongPressStart: (LongPressStartDetails _) => _startHold(),
        onLongPressEnd: (LongPressEndDetails _) => _cancelHold(),
        onLongPressCancel: _cancelHold,
        child: SizedBox(
          height: 48,
          width: double.infinity,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: TraccerTheme.red.withValues(alpha: widget.isDark ? 0.16 : 0.08),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: TraccerTheme.red.withValues(alpha: widget.isDark ? 0.45 : 0.32),
              ),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(11),
              child: Stack(
                fit: StackFit.expand,
                children: <Widget>[
                  // The alignment must live on the FractionallySizedBox itself: under the
                  // tight width constraints coming from StackFit.expand an outer Align is
                  // a no-op and the fill would grow from the centre.
                  FractionallySizedBox(
                    widthFactor: _progress.clamp(0.0, 1.0),
                    alignment: AlignmentDirectional.centerStart,
                    child: ColoredBox(
                      color: TraccerTheme.red.withValues(alpha: widget.isDark ? 0.42 : 0.26),
                    ),
                  ),
                  Center(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: <Widget>[
                          Icon(Icons.stop_circle_outlined, size: 18, color: ink),
                          const SizedBox(width: 8),
                          Flexible(
                            child: Text(
                              S.t('holdToStop'),
                              maxLines: 2,
                              textAlign: TextAlign.center,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: ink,
                                fontWeight: FontWeight.w700,
                                fontSize: 13,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
