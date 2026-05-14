import type { Route } from "./+types/home";
import { JobmateApp } from "../jobmate/jobmate-app";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "JobMate" },
    { name: "description", content: "JobMate web" },
  ];
}

export default function Home() {
  return <JobmateApp />;
}
