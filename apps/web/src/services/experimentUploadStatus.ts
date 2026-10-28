export interface ExperimentUploadStatus {
  lastAttemptAt: string | null;
  lastAcceptedAt: string | null;
  lastRejectedAt: string | null;
  acceptedRequests: number;
  rejectedRequests: number;
  lastError: { status: number; code: string; message: string } | null;
}
