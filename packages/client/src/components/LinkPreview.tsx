// SPDX-License-Identifier: Hippocratic-3.0

interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

export function LinkPreviewCards({
  previews,
}: {
  previews: LinkPreviewData[];
}) {
  if (!previews || previews.length === 0) return null;

  return (
    <div className="link-previews">
      {previews.map((p) => (
        <a
          key={p.url}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="link-preview-card"
        >
          {p.image && (
            <img
              src={p.image}
              alt=""
              className="link-preview-image"
              loading="lazy"
            />
          )}
          <div className="link-preview-body">
            {p.siteName && (
              <span className="link-preview-site">{p.siteName}</span>
            )}
            {p.title && (
              <span className="link-preview-title">{p.title}</span>
            )}
            {p.description && (
              <span className="link-preview-desc">
                {p.description.length > 200
                  ? p.description.slice(0, 200) + '…'
                  : p.description}
              </span>
            )}
          </div>
        </a>
      ))}
    </div>
  );
}
