"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const home: Record<string, string> = {
  catalog: "/office/products",
  warehouse: "/office/inventory",
  finance: "/office/refunds",
  administrator: "/office/scenarios",
};

export default function OfficeHome() {
  const router = useRouter();
  useEffect(() => {
    fetch("/api/session").then(async (response) => {
      const body = await response.json();
      router.replace(home[body.user?.role] ?? "/login");
    });
  }, [router]);
  return <p className="text-sm text-muted">Opening the back office...</p>;
}
