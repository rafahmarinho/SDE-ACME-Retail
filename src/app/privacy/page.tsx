import Link from "next/link";
import { NOTICE_SUMMARY, PRIVACY_CONTACT, PRIVACY_NOTICE_VERSION, PROCESSING_ACTIVITIES, WITHDRAWAL_TEXT } from "@/lib/privacy";

const BASIS_LABEL = {
  contract: "Needed to provide the service you asked for",
  consent: "Only with your consent",
  legitimate_interest: "Our legitimate interest; you can object",
  legal_obligation: "Required by law",
} as const;

/** Privacy notice: a short summary first, then the detailed version, both built from the privacy register. */
export default function PrivacyNoticePage() {
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold">Privacy notice</h1>
        <p className="text-sm text-muted">Version {PRIVACY_NOTICE_VERSION}. This notice is separate from any terms of sale.</p>
      </header>

      <section className="panel space-y-2 p-5" aria-labelledby="summary">
        <h2 id="summary" className="text-xl font-semibold">In short</h2>
        <ul className="list-disc space-y-1 pl-5">
          {NOTICE_SUMMARY.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </section>

      <section className="space-y-3" aria-labelledby="details">
        <h2 id="details" className="text-xl font-semibold">What we use your information for</h2>
        {PROCESSING_ACTIVITIES.map((item) => (
          <div key={item.id} className="panel space-y-1 p-4">
            <h3 className="font-semibold">{item.name} <span className="text-sm font-normal text-muted">({item.required ? "required to use the store" : "optional"})</span></h3>
            <p>{item.purpose}</p>
            <p className="text-sm"><strong>Information:</strong> {item.data.join(", ")}.</p>
            <p className="text-sm"><strong>Why we may do it:</strong> {BASIS_LABEL[item.basis]}.</p>
            <p className="text-sm"><strong>How long we keep it:</strong> {item.retention}</p>
            <p className="text-sm"><strong>Shared with:</strong> {item.recipients.join(", ")}.</p>
          </div>
        ))}
      </section>

      <section className="panel space-y-2 p-5" aria-labelledby="choices">
        <h2 id="choices" className="text-xl font-semibold">Your choices</h2>
        <p>{WITHDRAWAL_TEXT}</p>
        <p>Signed-in customers manage their choices on <Link className="text-accent" href="/account/privacy">Account &gt; Privacy</Link>.</p>
        <p>Questions, access or deletion requests: {PRIVACY_CONTACT}.</p>
      </section>
    </article>
  );
}
