export function LoadingState({ label = "Loading ACME Retail..." }: { label?: string }) {
  return (
    <div className="grid gap-3" aria-live="polite">
      <p className="text-sm text-muted">{label}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="panel h-48 animate-pulse bg-[#eef1ec]" />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return <div className="banner-error" role="alert">{message}</div>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="panel p-8 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted">{body}</p>
    </div>
  );
}
