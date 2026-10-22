/// Typed API failures (CONTRACT §3 error codes + generic HTTP).
///
/// The UI matches on these — never on raw status codes — so error copy stays Arabic and
/// specific (e.g. FENCE_VIOLATION shows the fence name + distance + "اتصل بالمشرف").
class ApiException implements Exception {
  const ApiException({required this.message, this.statusCode, this.code, this.data});

  final String message;
  final int? statusCode;
  final String? code;
  final Map<String, Object?>? data;

  @override
  String toString() => 'ApiException($statusCode, $code): $message';
}

/// 422 FENCE_VIOLATION (only when `settings.attendance.strictReject=true`).
class FenceViolationException extends ApiException {
  const FenceViolationException({
    required super.message,
    required this.fenceName,
    required this.distanceToCenterM,
    required this.allowedFences,
    super.statusCode,
    super.data,
  }) : super(code: 'FENCE_VIOLATION');

  final String? fenceName;
  final double? distanceToCenterM;
  final List<String> allowedFences;

  static FenceViolationException fromJson(Map<String, Object?> json) => FenceViolationException(
        message: (json['message'] ?? 'فشل التحقق من النطاق') as String,
        fenceName: json['fenceName'] as String?,
        distanceToCenterM: (json['distanceToCenterM'] as num?)?.toDouble(),
        allowedFences: (json['allowedFences'] is List)
            ? (json['allowedFences'] as List).map((Object? e) => e.toString()).toList()
            : const <String>[],
        statusCode: (json['statusCode'] as num?)?.toInt(),
        data: json,
      );
}

/// 409 ALREADY_CHECKED_IN — double check-in forbidden.
class AlreadyCheckedInException extends ApiException {
  const AlreadyCheckedInException({required super.message, super.statusCode, super.data})
      : super(code: 'ALREADY_CHECKED_IN');
}

/// NO_OPEN_RECORD — check-out (or end-of-shift) with no active session.
class NoOpenRecordException extends ApiException {
  const NoOpenRecordException({required super.message, super.statusCode, super.data})
      : super(code: 'NO_OPEN_RECORD');
}

/// 401 even after refresh — session is gone, force re-login.
class UnauthorizedException extends ApiException {
  const UnauthorizedException({super.message = 'انتهت الجلسة، سجّل الدخول مرة أخرى'})
      : super(code: 'UNAUTHORIZED', statusCode: 401);
}

/// Network/reachability failure (used to flip the app into buffer-only mode).
class NetworkException extends ApiException {
  const NetworkException({required super.message})
      : super(code: 'NETWORK', statusCode: null);
}
