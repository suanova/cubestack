import { redirect } from "next/navigation";

// The prototype's landing page lives in public/overview.html; the dev server
// starts there.
export default function Home() {
  redirect("/overview.html");
}
