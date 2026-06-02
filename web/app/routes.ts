import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/fetch-html", "routes/api.fetch-html.ts"),
  route("api/job-logo", "routes/api.job-logo.ts"),
  route("api/parse-job", "routes/api.parse-job.ts"),
  route("api/job-enrich", "routes/api.job-enrich.ts"),
  route("api/job-contacts", "routes/api.job-contacts.ts"),
  route("api/jobteaser-location", "routes/api.jobteaser-location.ts"),
  route("api/chrome-apply/register", "routes/api.chrome-apply.register.ts"),
  route("api/chrome-apply/:sessionId/payload", "routes/api.chrome-apply.session.payload.ts"),
  route("api/chrome-apply/:sessionId/answers", "routes/api.chrome-apply.session.answers.ts"),
  route("api/chrome-apply/:sessionId/analyze", "routes/api.chrome-apply.session.analyze.ts"),
  route("api/chrome-apply/:sessionId/complete", "routes/api.chrome-apply.session.complete.ts")
] satisfies RouteConfig;
