"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { officeHome } from "@/lib/policy";

export default function OfficeHome() {
  const router = useRouter();
  useEffect(() => {
    fetch("/api/session").then(async (response) => {
      const body = await response.json();
      router.replace((body.user && officeHome(body.user.role)) ?? "/login");
    });
  }, [router]);
  return <p className="text-sm text-muted">Opening the back office...</p>;
}
