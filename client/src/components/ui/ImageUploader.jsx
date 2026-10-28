import { useRef, useState } from 'react';
import { AnimatePresence, Reorder, motion } from 'framer-motion';
import { ImagePlus, Star, UploadCloud, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/format';
import { Spinner } from './Feedback';

/**
 * Drag & drop image uploader. Files go to POST /api/uploads (S3 in production, local disk in dev).
 * `value` is [{ url, key }]; the first image is the cover. Images can be reordered by dragging.
 */
export default function ImageUploader({ value = [], onChange, max = 8, folder = 'products', single = false }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [progress, setProgress] = useState(0);

  async function upload(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const room = single ? 1 : max - value.length;
    if (room <= 0) {
      toast.error(`You can add up to ${max} images`);
      return;
    }
    const batch = files.slice(0, room);
    const tooBig = batch.find((f) => f.size > 5 * 1024 * 1024);
    if (tooBig) {
      toast.error(`${tooBig.name} is larger than 5 MB`);
      return;
    }
    const form = new FormData();
    batch.forEach((f) => form.append('images', f));
    setUploading(batch.length);
    setProgress(0);
    try {
      const { data } = await api.post(`/uploads?folder=${folder}`, form, {
        onUploadProgress: (e) => e.total && setProgress(Math.round((e.loaded / e.total) * 100)),
      });
      onChange(single ? data.files.slice(0, 1) : [...value, ...data.files]);
      toast.success(`${data.files.length} image${data.files.length > 1 ? 's' : ''} uploaded`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setUploading(0);
    }
  }

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer.files);
  };

  const remove = (url) => onChange(value.filter((img) => img.url !== url));
  const makeCover = (img) => onChange([img, ...value.filter((i) => i.url !== img.url)]);

  return (
    <div className="space-y-3">
      <motion.div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        animate={{ scale: dragging ? 1.01 : 1 }}
        className={cn(
          'relative flex cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors',
          dragging
            ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10'
            : 'border-zinc-300 hover:border-brand-400 hover:bg-zinc-50 dark:border-white/15 dark:hover:bg-white/[0.03]',
        )}
      >
        <input ref={inputRef} type="file" accept="image/*" multiple={!single} hidden onChange={(e) => upload(e.target.files)} />
        {uploading ? (
          <>
            <Spinner className="h-7 w-7 text-brand-600" />
            <p className="text-sm font-semibold">
              Uploading {uploading} image{uploading > 1 ? 's' : ''}… {progress}%
            </p>
            <div className="absolute inset-x-0 bottom-0 h-1 bg-zinc-100 dark:bg-white/10">
              <motion.div className="h-full bg-gradient-to-r from-brand-500 to-indigo-500" animate={{ width: `${progress}%` }} />
            </div>
          </>
        ) : (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
              <UploadCloud className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold">
              <span className="text-brand-600 dark:text-brand-300">Click to upload</span> or drag and drop
            </p>
            <p className="text-xs muted">PNG, JPG, WEBP up to 5 MB{single ? '' : ` · up to ${max} images`}</p>
          </>
        )}
      </motion.div>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-3">
        <Reorder.Group as="div" axis="x" values={value} onReorder={onChange} className="flex flex-wrap gap-3">
          <AnimatePresence initial={false}>
            {value.map((img, index) => (
              <Reorder.Item
                as="div"
                key={img.url}
                value={img}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                whileDrag={{ scale: 1.06, zIndex: 10 }}
                className="group relative h-24 w-24 cursor-grab overflow-hidden rounded-xl bg-zinc-100 ring-1 ring-zinc-200 active:cursor-grabbing dark:bg-white/5 dark:ring-white/10"
              >
                <img src={img.url} alt="" className="pointer-events-none h-full w-full object-contain p-1" />
                {index === 0 && !single && (
                  <span className="absolute bottom-1 left-1 rounded-md bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-white">COVER</span>
                )}
                <div className="absolute inset-0 flex items-start justify-end gap-1 bg-black/0 p-1 opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100">
                  {index > 0 && (
                    <button type="button" onClick={() => makeCover(img)} className="rounded-lg bg-white/90 p-1 text-zinc-700 hover:bg-white" title="Make cover">
                      <Star className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button type="button" onClick={() => remove(img.url)} className="rounded-lg bg-white/90 p-1 text-rose-600 hover:bg-white" title="Remove">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </Reorder.Item>
            ))}
          </AnimatePresence>
        </Reorder.Group>
          {!single && value.length < max && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-zinc-300 text-zinc-400 transition hover:border-brand-400 hover:text-brand-600 dark:border-white/15"
            >
              <ImagePlus className="h-5 w-5" />
              <span className="text-[11px] font-semibold">Add more</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
