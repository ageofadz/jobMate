import { render } from "ink";
import React from "react";

import { reportError } from "../report-error";
import { DashboardApp } from "./DashboardApp";

export async function runDashboard(userId: string) {
  try {
    await new Promise<void>((resolve) => {
      const instance = render(
        <DashboardApp
          userId={userId}
          onExit={() => {
            instance.unmount();
            resolve();
          }}
        />
      );
    });
  } catch (err) {
    reportError("Dashboard session error", err);
  }
}
