import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMetadataStore, type MetadataStore } from "@datafoundry/metadata";

import type { PasswordAuthConfig } from "./config.js";
import { AuthError, AuthService } from "./service.js";

const ADMIN_EMAIL = "admin@fusion.local";
const SERVICE_TOKEN = "unit-test-service-token";

const buildAuthConfig = (overrides: Partial<PasswordAuthConfig> = {}): PasswordAuthConfig => ({
  publicBaseUrl: "http://127.0.0.1:8787",
  registrationMode: "open",
  cookiePath: "/",
  cookieSecure: false,
  sessionSecret: "unit-test-session-secret-0123456789abcdef",
  emailDelivery: "test",
  serviceToken: SERVICE_TOKEN,
  ...overrides
});

const provisionAdminUser = (metadata: MetadataStore): void => {
  metadata.users.createPasswordUser({
    id: randomUUID(),
    email: ADMIN_EMAIL,
    display_name: "Admin"
  });
};

describe("AuthService.authenticateServiceToken", () => {
  let root: string;
  let metadata: MetadataStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "service-token-auth-"));
    metadata = createMetadataStore({ database_path: join(root, "metadata.sqlite") });
  });

  afterEach(() => {
    metadata.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts the configured token and returns the admin identity with a personal workspace and no session", () => {
    provisionAdminUser(metadata);
    const authService = new AuthService(metadata, buildAuthConfig());

    const identity = authService.authenticateServiceToken(SERVICE_TOKEN);

    expect(identity.user.email).toBe(ADMIN_EMAIL);
    expect(identity.workspace.id).toBe(`personal-${identity.user.id}`);
    expect(identity.workspace.owner_user_id).toBe(identity.user.id);
    expect(identity.session).toBeUndefined();
  });

  it("rejects a wrong token with 401", () => {
    provisionAdminUser(metadata);
    const authService = new AuthService(metadata, buildAuthConfig());

    expect(() => authService.authenticateServiceToken("wrong-token")).toThrowError(AuthError);
    try {
      authService.authenticateServiceToken("wrong-token");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).status).toBe(401);
    }
  });

  it("rejects any token with 401 when no service token is configured", () => {
    provisionAdminUser(metadata);
    const authService = new AuthService(metadata, buildAuthConfig({ serviceToken: "" }));

    try {
      authService.authenticateServiceToken(SERVICE_TOKEN);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).status).toBe(401);
      expect((error as AuthError).message).toContain("disabled");
    }
  });

  it("rejects with 401 when the admin service user is not provisioned", () => {
    const authService = new AuthService(metadata, buildAuthConfig());

    try {
      authService.authenticateServiceToken(SERVICE_TOKEN);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).status).toBe(401);
    }
  });
});
