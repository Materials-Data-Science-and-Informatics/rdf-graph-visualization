/**
 * Full-screen loading overlay (C0 S3: pure CSS spinner, replaces the Chakra
 * Spinner — same size/thickness/speed as before: 36px, 4px, 0.65s, blue.500).
 */
function LoadingSpinner() {
  return (
    <div className="fixed inset-0 z-[9999] flex h-screen w-screen items-center justify-center bg-black/50">
      <div
        className="size-9 animate-spin rounded-full border-4 border-blue-500 border-t-transparent"
        style={{ animationDuration: "0.65s" }}
        role="status"
        aria-label="Loading"
      />
    </div>
  );
}

export default LoadingSpinner;
