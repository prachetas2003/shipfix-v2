import { notFound } from "next/navigation";
import { DeployErrorDetail } from "../../components/DeployErrorPage";
import { deployErrorBySlug, deployErrors } from "../../lib/deployErrors";

export function generateStaticParams(): { slug: string }[] {
  return deployErrors.map((error) => ({ slug: error.slug }));
}

export default async function ErrorDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactElement> {
  const { slug } = await params;
  const error = deployErrorBySlug(slug);
  if (!error) notFound();
  return <DeployErrorDetail error={error} />;
}
