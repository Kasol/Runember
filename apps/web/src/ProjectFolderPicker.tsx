import { useEffect, useState } from 'react';
import { client, type ProjectFolder, type ProjectFolderListing } from './api';
import { FormActions, Modal } from './ui';

export function ProjectFolderPicker({ initialPath, onSelect, onClose }: {
  initialPath?: string;
  onSelect: (folder: ProjectFolder) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<ProjectFolderListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const browse = async (path?: string) => {
    setLoading(true);
    setError('');
    try { setListing(await client.projectFolders(path)); }
    catch (error) { setError((error as Error).message); }
    finally { setLoading(false); }
  };

  useEffect(() => { void browse(initialPath); }, [initialPath]);

  const current = listing?.current;
  return (
    <Modal title="选择项目文件夹" onClose={onClose}>
      <div className="folder-picker">
        <div className="row">
          <button disabled={loading || (listing?.current === null && !error)} onClick={() => void browse()}>所有位置</button>
          <button disabled={loading || !current} onClick={() => void browse(listing?.parent ?? undefined)}>上一级</button>
        </div>
        <p className="folder-path">{current?.path ?? 'daemon 主机的文件夹'}</p>
        {loading && <p className="dim" role="status">正在读取文件夹…</p>}
        {error && <p className="form-err" role="alert">{error}</p>}
        {listing && (listing.folders.length ? (
          <ul className="folder-list">
            {listing.folders.map(folder => (
              <li key={folder.path}>
                <button disabled={loading} onClick={() => void browse(folder.path)}>
                  {folder.name}<span aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="dim">没有子文件夹</p>)}
        <FormActions primary="选择此文件夹" disabled={loading || !current || !!error}
          onPrimary={() => { if (current) onSelect(current); }} secondary="取消" onSecondary={onClose} />
      </div>
    </Modal>
  );
}
