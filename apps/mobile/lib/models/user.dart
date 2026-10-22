/// User as returned by `/auth/login` and `/auth/me` (CONTRACT §2).
///
/// `user = { id, identifier, name, role, employeeId, phone, siteId?, zoneId?, driver }`
class AppUser {
  const AppUser({
    required this.id,
    required this.identifier,
    required this.name,
    required this.role,
    required this.employeeId,
    required this.phone,
    required this.driver,
    this.siteId,
    this.zoneId,
    this.mustChangePassword = false,
  });

  final String id;
  final String identifier; // employee code used to log in
  final String name;
  final String role; // ADMIN | SUPERVISOR | EMPLOYEE | DRIVER
  final String employeeId;
  final String phone;
  final bool driver;
  final String? siteId; // employee fence anchor
  final String? zoneId; // driver fence anchor
  final bool mustChangePassword;

  bool get isDriver => driver || role == 'DRIVER';
  bool get isEmployeeOnly => role == 'EMPLOYEE';

  static AppUser fromJson(Map<String, Object?> json) => AppUser(
        id: (json['id'] ?? '') as String,
        identifier: (json['identifier'] ?? '') as String,
        name: (json['name'] ?? '') as String,
        role: (json['role'] ?? 'EMPLOYEE') as String,
        employeeId: (json['employeeId'] ?? '') as String,
        phone: (json['phone'] ?? '') as String,
        driver: (json['driver'] ?? false) as bool,
        siteId: json['siteId'] as String?,
        zoneId: json['zoneId'] as String?,
        mustChangePassword:
            (json['mustChangePassword'] ?? json['changeOnLogin'] ?? false) as bool,
      );

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'identifier': identifier,
        'name': name,
        'role': role,
        'employeeId': employeeId,
        'phone': phone,
        'driver': driver,
        'siteId': siteId,
        'zoneId': zoneId,
        'mustChangePassword': mustChangePassword,
      };
}

/// Result of `POST /auth/login` / `/auth/refresh`.
class AuthTokens {
  const AuthTokens({
    required this.accessToken,
    required this.refreshToken,
    this.user,
    this.mustChangePassword = false,
  });

  final String accessToken;
  final String refreshToken;
  final AppUser? user;
  final bool mustChangePassword;

  static AuthTokens fromJson(Map<String, Object?> json) => AuthTokens(
        accessToken: (json['accessToken'] ?? '') as String,
        refreshToken: (json['refreshToken'] ?? '') as String,
        user: json['user'] is Map<String, Object?>
            ? AppUser.fromJson((json['user'] as Map<String, Object?>))
            : null,
        mustChangePassword:
            (json['mustChangePassword'] ?? json['changeOnLogin'] ?? false) as bool,
      );
}
