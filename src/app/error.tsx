"use client";

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="panel space-y-3 p-6">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted">The page could not be shown. No sensitive details are included in this message.</p>
      <button className="btn" type="button" onClick={() => reset()}>Try again</button>
      <p className="sr-only">{error.message}</p>
    </div>
  );
}
