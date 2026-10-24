"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthFlow, PasswordAuthShell } from "../../components/auth/auth-flow";
import { configApi } from "../../lib/config-api/client";

export function RegisterClient() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      configApi.getMe().then(() => true).catch(() => false),
      configApi.getAuthStatus().then((status) => status.registrationEnabled).catch(() => true),
    ]).then(([signedIn, canRegister]) => {
      if (cancelled) return;
      if (signedIn) {
        router.replace("/data-tasks");
        return;
      }
      setRegistrationEnabled(canRegister);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (checking) {
    return <PasswordAuthShell title="正在加载账号…" />;
  }

  if (!registrationEnabled) {
    return (
      <PasswordAuthShell
        title="注册已关闭"
        subtitle="注册已关闭，请联系部署管理员。"
      >
        <button
          type="button"
          className="text-sm font-medium text-foreground underline-offset-2 hover:underline"
          onClick={() => router.push("/login")}
        >
          返回登录
        </button>
      </PasswordAuthShell>
    );
  }

  return (
    <AuthFlow
      initialMode="register"
      registrationEnabled={registrationEnabled}
      onAuthenticated={() => router.replace("/data-tasks")}
    />
  );
}
