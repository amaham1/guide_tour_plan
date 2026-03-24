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
