import { redirect } from "next/navigation";

/** The profile lives in Settings now; old links and bookmarks land there. */
export default function AccountPage() {
  redirect("/settings?section=profile");
}
