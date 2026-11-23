/** The outside world the privacy features reach into. Real implementations live in privacy.module.ts; tests use doubles. */

/** Deletes objects from object storage. Deleting a missing key must succeed (S3 semantics), so every call is repeatable. */
export interface ObjectEraser {
  deleteFileObject(key: string): Promise<void>;
  deleteRecordingObject(key: string): Promise<void>;
}

/** The identity provider side of an erasure. */
export interface PrivacyIdentity {
  /**
   * Ends every session of the user and deletes the account. Must be repeatable (an already deleted user is success) and must
   * refuse a user that does not belong to `orgSlug`. Throws IdentityAdminError when the provider cannot be reached.
   */
  eraseUser(sub: string, orgSlug: string): Promise<void>;
}

/** Revokes the stored calendar grants at the provider where one exists (best effort; the stored copy is deleted regardless). */
export interface CalendarRevoker {
  revokeAll(orgId: string, userId: string): Promise<void>;
}
