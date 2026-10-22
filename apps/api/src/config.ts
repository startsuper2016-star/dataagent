import { createEnvConfig } from "@datafoundry/contracts";

export type ApiConfig = {
  host: string;
  port: number;
  service_token?: string;
};

export const loadApiConfig = (): ApiConfig => createEnvConfig(process.env).api;
