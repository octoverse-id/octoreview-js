/**
 * Error codes the server sends (docs/errors.md). The contract gate checks this set against the
 * vendored contract's ErrorCode enum, in both directions.
 */
export const ErrorCode = {
  VALIDATION_ERROR: "validation_error",
  INVALID_NAMESPACE: "invalid_namespace",
  APPLICATION_MISMATCH: "application_mismatch",
  MEDIA_TOO_LARGE: "media_too_large",
  CONTENT_TYPE_NOT_ALLOWED: "content_type_not_allowed",
  AUTHENTICATION_REQUIRED: "authentication_required",
  INVALID_API_KEY: "invalid_api_key",
  PERMISSION_DENIED: "permission_denied",
  UPLOAD_TOKEN_INVALID: "upload_token_invalid",
  MEDIA_TOKEN_INVALID: "media_token_invalid",
  NOT_FOUND: "not_found",
  METHOD_NOT_ALLOWED: "method_not_allowed",
  NOT_ACCEPTABLE: "not_acceptable",
  REVIEW_EXISTS: "review_exists",
  ENTITY_INACTIVE: "entity_inactive",
  INVALID_TRANSITION: "invalid_transition",
  REVIEW_CHANGED: "review_changed",
  REVISION_SUPERSEDED: "revision_superseded",
  REVISION_STALE: "revision_stale",
  SOURCE_REF_IMMUTABLE: "source_ref_immutable",
  REVIEW_NOT_ACCEPTING_MEDIA: "review_not_accepting_media",
  MEDIA_LIMIT_EXCEEDED: "media_limit_exceeded",
  STORAGE_QUOTA_EXCEEDED: "storage_quota_exceeded",
  UPLOAD_EXPIRED: "upload_expired",
  UPLOAD_NOT_FOUND: "upload_not_found",
  UPLOAD_CHANGED: "upload_changed",
  COMPLETE_IN_PROGRESS: "complete_in_progress",
  UPLOAD_ALREADY_COMPLETED: "upload_already_completed",
  UPLOAD_TOKEN_EXPIRED: "upload_token_expired",
  MEDIA_TOKEN_EXPIRED: "media_token_expired",
  CONTENT_LENGTH_REQUIRED: "content_length_required",
  UPLOAD_TOO_LARGE: "upload_too_large",
  UNSUPPORTED_MEDIA_TYPE: "unsupported_media_type",
  RANGE_NOT_SATISFIABLE: "range_not_satisfiable",
  MEDIA_REJECTED: "media_rejected",
  INTERNAL_ERROR: "internal_error",
  STORAGE_UNAVAILABLE: "storage_unavailable",
  STORAGE_CREDENTIALS_EXPIRING: "storage_credentials_expiring",
  TOO_MANY_COMPLETIONS: "too_many_completions",
} as const;

/** One of the server's error codes. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
