export class SetupRequiredError extends Error {
  readonly status = 503;
  readonly code = "SETUP_REQUIRED";

  constructor(
    message = "데이터 카탈로그가 아직 적재되지 않았습니다. 먼저 ingest를 실행해 주세요.",
  ) {
    super(message);
    this.name = "SetupRequiredError";
  }
}

export class InternalAdminDisabledError extends Error {
  readonly status = 404;
  readonly code = "INTERNAL_ADMIN_DISABLED";

  constructor(message = "내부 관리자 기능이 비활성화되어 있습니다.") {
    super(message);
    this.name = "InternalAdminDisabledError";
  }
}

export class ResourceNotFoundError extends Error {
  readonly status = 404;
  readonly code = "RESOURCE_NOT_FOUND";

  constructor(message = "요청한 데이터를 찾을 수 없습니다.") {
    super(message);
    this.name = "ResourceNotFoundError";
  }
}

export class InvalidRequestError extends Error {
  readonly status = 400;
  readonly code = "INVALID_REQUEST";

  constructor(message = "잘못된 요청입니다.") {
    super(message);
    this.name = "InvalidRequestError";
  }
}

export class DependencyUnavailableError extends Error {
  readonly status = 503;
  readonly code = "DEPENDENCY_UNAVAILABLE";

  constructor(message = "?꾩닔 ?쓽議댁꽦 ?쒕퉬?ㅼ뿉 ?곌껐??紐삵뻽?듬땲??") {
    super(message);
    this.name = "DependencyUnavailableError";
  }
}

export class UpstreamServiceError extends Error {
  readonly status = 502;
  readonly code = "UPSTREAM_SERVICE_ERROR";

  constructor(message = "?몃? ?쒕퉬??붿껌???ㅽ뙣?덉뒿?덈떎.") {
    super(message);
    this.name = "UpstreamServiceError";
  }
}

export class RouteNotFoundError extends Error {
  readonly status = 422;
  readonly code = "ROUTE_NOT_FOUND";

  constructor(message = "?붾줈瑜?李얠? 紐삵뻽?듬땲??") {
    super(message);
    this.name = "RouteNotFoundError";
  }
}
