import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  CircleDashed,
  Edit2,
  ExternalLink,
  FileText,
  Loader2,
  Package,
  PackageCheck,
  PackageSearch,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fetchApi, fetchJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { User } from "@/types/auth";
import type {
  AvailabilityState,
  CatalogAsset,
  CatalogComponent,
  ImportCompletedResponse,
  PaginatedComponents,
  ReleaseStatus,
  SelectionRequiredResponse,
  WorkflowStage,
} from "@/types/catalog";

const getErrorMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const CATALOG_PAGE_SIZE = 100;


// ─── Types ─────────────────────────────────────────────────────────────────

interface LibraryManagerPanelProps {
  user: User | null;
}

type SortKey = "name" | "manufacturer" | "category" | "package_name" | "availability_state" | "workflow_stage";
type SortDir = "asc" | "desc";
type LibraryView = "table" | "workflow";

type ImportSelection = {
  file: File;
  targetLibrary: string;
  options: string[];
  selected: string;
};

type CatalogCategory = {
  name: string;
  count: number;
};

type NewComponentFormState = {
  value: string;
  description: string;
  datasheet: string;
  manufacturer: string;
  manufacturerPartNumber: string;
  category: string;
  packageName: string;
  vendor: string;
  vendorPartNumber: string;
  massG: string;
  rqjcCW: string;
  rqjcTopCW: string;
  tempMaxC: string;
  tempMinC: string;
  powerDissipationW: string;
  rate: string;
  sapCode: string;
};

const EMPTY_FORM: NewComponentFormState = {
  value: "",
  description: "",
  datasheet: "",
  manufacturer: "",
  manufacturerPartNumber: "",
  category: "",
  packageName: "",
  vendor: "",
  vendorPartNumber: "",
  massG: "",
  rqjcCW: "",
  rqjcTopCW: "",
  tempMaxC: "",
  tempMinC: "",
  powerDissipationW: "",
  rate: "",
  sapCode: "",
};

// ─── Availability helpers ───────────────────────────────────────────────────

const STATE_META: Record<
  AvailabilityState,
  { label: string; color: string; icon: React.ReactNode }
> = {
  place_ready: {
    label: "Place Ready",
    color: "text-emerald-400",
    icon: <PackageCheck className="h-3.5 w-3.5" />,
  },
  files_partial: {
    label: "Partial",
    color: "text-amber-400",
    icon: <Package className="h-3.5 w-3.5" />,
  },
  metadata_only: {
    label: "Metadata Only",
    color: "text-zinc-400",
    icon: <CircleDashed className="h-3.5 w-3.5" />,
  },
};

const WORKFLOW_META: Record<
  WorkflowStage,
  { label: string; className: string }
> = {
  open: {
    label: "Open",
    className: "border-border text-muted-foreground",
  },
  in_progress: {
    label: "In Progress",
    className: "border-sky-500/30 text-sky-400",
  },
  qa_review: {
    label: "QA Review",
    className: "border-amber-500/30 text-amber-400",
  },
  done: {
    label: "Done",
    className: "border-emerald-500/30 text-emerald-400",
  },
  released: {
    label: "Released",
    className: "border-emerald-500/30 text-emerald-400",
  },
  archived: {
    label: "Archived",
    className: "border-red-500/30 text-red-400",
  },
};

const WORKFLOW_ORDER: WorkflowStage[] = ["open", "in_progress", "qa_review", "done", "released", "archived"];

const WORKFLOW_TRANSITIONS: Record<WorkflowStage, WorkflowStage[]> = {
  open: ["in_progress", "archived"],
  in_progress: ["qa_review", "open", "archived"],
  qa_review: ["done", "in_progress", "archived"],
  done: ["released", "qa_review", "archived"],
  released: ["archived"],
  archived: ["open"],
};

const workflowStage = (component: CatalogComponent): WorkflowStage =>
  component.workflow_stage ?? component.release_status;

function AvailabilityBadge({ state }: { state: AvailabilityState }) {
  const meta = STATE_META[state] ?? STATE_META.metadata_only;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", meta.color)}>
      {meta.icon}
      {meta.label}
    </span>
  );
}

function ReleaseBadge({ status }: { status: ReleaseStatus }) {
  const meta = WORKFLOW_META[status];
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", meta.className)}>
      {meta.label}
    </span>
  );
}

// ─── Asset row ──────────────────────────────────────────────────────────────

const ASSET_LABELS: Record<string, string> = {
  symbol: "Symbol",
  footprint: "Footprint",
  "3dmodel": "3D Model",
  spice: "SPICE Netlist",
};

function AssetRow({
  type,
  asset,
  onDetach,
  onAttach,
}: {
  type: "symbol" | "footprint" | "3dmodel" | "spice";
  asset: CatalogAsset | undefined;
  onDetach: (type: string) => void;
  onAttach: (type: string) => void;
}) {
  const label = ASSET_LABELS[type] ?? type;
  const required = type === "symbol" || type === "footprint";

  return (
    <div className="flex items-center justify-between rounded-md border border-border/50 bg-card px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        {asset ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
        ) : required ? (
          <XCircle className="h-4 w-4 shrink-0 text-red-400" />
        ) : (
          <CircleDashed className="h-4 w-4 shrink-0 text-zinc-500" />
        )}
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">{label}</p>
          {asset && (
            <p className="text-[10px] text-muted-foreground truncate">
              {asset.target_library} / {asset.target_name}
            </p>
          )}
          {!asset && required && (
            <p className="text-[10px] text-red-400">Required — missing</p>
          )}
          {!asset && !required && (
            <p className="text-[10px] text-muted-foreground">Optional — not attached</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 ml-2 shrink-0">
        {asset ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px] text-red-400 hover:text-red-300 hover:bg-red-500/10"
            onClick={() => onDetach(type)}
          >
            <Trash2 className="h-3 w-3 mr-1" />
            Detach
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={() => onAttach(type)}
          >
            <Upload className="h-3 w-3 mr-1" />
            Attach
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Field row in detail panel ──────────────────────────────────────────────

function FieldRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[120px_1fr] gap-x-3 py-1">
      <dt className="text-[11px] font-medium text-muted-foreground truncate">{label}</dt>
      <dd className="text-[11px] text-foreground break-words">{value}</dd>
    </div>
  );
}

// ─── SVG Preview ────────────────────────────────────────────────────────────

function SvgPreview({ component, kind }: { component: CatalogComponent; kind: "symbol" | "footprint" }) {
  const preview = component.previews.find((p) => p.kind === kind);
  if (!preview || preview.status !== "ready") return null;
  const cacheKey = encodeURIComponent(preview.updated_at || preview.id);
  return (
    <img
      src={`/api/remote-provider/previews/${preview.id}?v=${cacheKey}`}
      alt={`${kind} preview`}
      className="w-full h-full object-contain"
    />
  );
}

// ─── Sort button ─────────────────────────────────────────────────────────────

function SortButton({
  col,
  current,
  dir,
  onClick,
  children,
}: {
  col: SortKey;
  current: SortKey;
  dir: SortDir;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const active = col === current;
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
      {active ? (
        dir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
      ) : (
        <ChevronsUpDown className="h-3 w-3 opacity-40" />
      )}
    </button>
  );
}

// ─── File picker ─────────────────────────────────────────────────────────────

function FilePicker({
  id,
  label,
  accept,
  file,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  accept: string;
  file: File | null;
  placeholder: string;
  onChange: (f: File | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <input ref={ref} id={id} type="file" accept={accept} className="hidden" onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={() => ref.current?.click()}
        >
          <Upload className="h-3 w-3 mr-1.5" />
          {file ? file.name : placeholder}
        </Button>
        {file && (
          <button type="button" onClick={() => onChange(null)} className="text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function LibraryManagerPanel({ user }: LibraryManagerPanelProps) {
  // ── data state ──
  const [components, setComponents] = useState<CatalogComponent[]>([]);
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // ── filter / sort ──
  const [query, setQuery] = useState("");
  const [filterState, setFilterState] = useState<AvailabilityState | "">("");
  const [filterWorkflow, setFilterWorkflow] = useState<WorkflowStage | "">("");
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<LibraryView>("table");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const deferredQuery = useDeferredValue(query);

  // ── selection ──
  const [selected, setSelected] = useState<CatalogComponent | null>(null);

  // ── pane state ──

  // ── dialogs ──
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newDialogTab, setNewDialogTab] = useState<"manual" | "csv">("manual");
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAttachDialog, setShowAttachDialog] = useState<{
    assetType: "symbol" | "footprint" | "3dmodel" | "spice";
  } | null>(null);
  const [attachTab, setAttachTab] = useState<"upload" | "link">("upload");
  const [showDetachConfirm, setShowDetachConfirm] = useState<string | null>(null);

  // ── forms ──
  const [newForm, setNewForm] = useState<NewComponentFormState>(EMPTY_FORM);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [stockCsvFile, setStockCsvFile] = useState<File | null>(null);
  const [editForm, setEditForm] = useState<Partial<NewComponentFormState>>({});
  const [submitting, setSubmitting] = useState(false);
  const [releaseSubmitting, setReleaseSubmitting] = useState(false);
  const [importSelection, setImportSelection] = useState<ImportSelection | null>(null);
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [attachTargetLibrary, setAttachTargetLibrary] = useState("");
  const [availableLinks, setAvailableLinks] = useState<string[]>([]);
  const [selectedLink, setSelectedLink] = useState("");
  const [selectedLinkTargetLibrary, setSelectedLinkTargetLibrary] = useState("");
  const [selectedLinkTargetName, setSelectedLinkTargetName] = useState("");

  useEffect(() => {
    setCurrentPage(1);
  }, [deferredQuery, filterCategory, filterState, filterWorkflow, sortKey, sortDir, viewMode]);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ categories: CatalogCategory[] }>("/api/catalog/categories")
      .then((res) => {
        if (!cancelled) setCategories(res.categories);
      })
      .catch((err) => {
        if (!cancelled) console.error("Failed to load catalog categories", err);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // ── fetch ──
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const loadPage = async () => {
      const params = new URLSearchParams({
        page_size: String(CATALOG_PAGE_SIZE),
        page: String(currentPage),
        sort_by: sortKey,
        sort_dir: sortDir,
      });
      const searchText = deferredQuery.trim();
      if (searchText) params.set("q", searchText);
      if (filterCategory !== null) params.set("category", filterCategory);
      if (viewMode === "workflow" && filterState) params.set("availability_state", filterState);
      if (viewMode === "table" && filterWorkflow) params.set("workflow_stage", filterWorkflow);

      const res = await fetchJson<PaginatedComponents>(`/api/catalog/components?${params.toString()}`);
      if (!cancelled) {
        setComponents(res.items);
        setTotal(res.total);
        setTotalPages(res.pages);
        if (currentPage > res.pages) setCurrentPage(res.pages);
      }
    };

    loadPage()
      .catch((err) => {
        if (!cancelled) toast.error(getErrorMsg(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey, currentPage, deferredQuery, filterCategory, filterState, filterWorkflow, viewMode, sortKey, sortDir]);

  // ── filtered + sorted list ──
  const filtered = useMemo(() => {
    const list = components;
    return [...list].sort((a, b) => {
      const av = String(a[sortKey] ?? "").toLowerCase();
      const bv = String(b[sortKey] ?? "").toLowerCase();
      return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }, [components, sortKey, sortDir]);

  const categoryNames = useMemo(() => categories.map((category) => category.name), [categories]);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setSelected(null);
  }, []);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  // ── keep selected in sync after refresh ──
  useEffect(() => {
    setSelected((current) => {
      if (!current) return current;
      return components.find((c) => c.id === current.id) ?? current;
    });
  }, [components]);

  // ─── Create component (Manual) ───────────────────────────────────────
  const handleCreate = async () => {
    setSubmitting(true);
    try {
      const body = {
        value: newForm.value,
        description: newForm.description,
        datasheet: newForm.datasheet,
        manufacturer: newForm.manufacturer,
        manufacturer_part_number: newForm.manufacturerPartNumber,
        category: newForm.category,
        package_name: newForm.packageName,
        vendor: newForm.vendor,
        vendor_part_number: newForm.vendorPartNumber,
        mass_g: newForm.massG,
        rqjc_c_w: newForm.rqjcCW,
        rqjc_top_c_w: newForm.rqjcTopCW,
        temp_max_c: newForm.tempMaxC,
        temp_min_c: newForm.tempMinC,
        power_dissipation_w: newForm.powerDissipationW,
        rate: newForm.rate,
        sap_code: newForm.sapCode,
      };
      await fetchJson("/api/catalog/components", { method: "POST", body: JSON.stringify(body) });
      toast.success("Component created");
      setShowNewDialog(false);
      setNewForm(EMPTY_FORM);
      refresh();
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ─── CSV Imports ─────────────────────────────────────────────────────
  const handleCsvImport = async () => {
    if (!csvFile) return;
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("file", csvFile);
      const resp = await fetchJson<{created: number, updated: number, errors: string[]}>("/api/catalog/components/import-csv", {
        method: "POST",
        body: form,
      });
      toast.success(`Imported/Updated ${resp.created + resp.updated} components`);
      if (resp.errors && resp.errors.length > 0) {
        toast.warning(`${resp.errors.length} rows encountered errors (check console)`);
        console.warn("CSV Import Errors:", resp.errors);
      }
      setShowNewDialog(false);
      setCsvFile(null);
      refresh();
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleStockCsvImport = async () => {
    if (!stockCsvFile) return;
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("file", stockCsvFile);
      const resp = await fetchJson<{updated: number, not_found: number, errors: string[]}>("/api/catalog/stock/sync-csv", {
        method: "POST",
        body: form,
      });
      toast.success(`Updated stock for ${resp.updated} components`);
      if (resp.not_found > 0) {
        toast.info(`${resp.not_found} components from CSV not found in catalog`);
      }
      if (resp.errors && resp.errors.length > 0) {
        toast.warning(`${resp.errors.length} rows encountered errors (check console)`);
        console.warn("Stock Import Errors:", resp.errors);
      }
      setShowNewDialog(false);
      setStockCsvFile(null);
      refresh();
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setSubmitting(false);
    }
  };


  // ─── Edit component ──────────────────────────────────────────────────
  const openEdit = () => {
    if (!selected) return;
    setEditForm({
      value: selected.value,
      description: selected.description,
      datasheet: selected.datasheet_url,
      manufacturer: selected.manufacturer,
      manufacturerPartNumber: selected.mpn,
      category: selected.category,
      packageName: selected.package_name,
      vendor: selected.vendor,
      vendorPartNumber: selected.vendor_part_number,
      massG: selected.mass_g,
      rqjcCW: selected.rqjc_c_w,
      rqjcTopCW: selected.rqjc_top_c_w,
      tempMaxC: selected.temp_max_c,
      tempMinC: selected.temp_min_c,
      powerDissipationW: selected.power_dissipation_w,
      rate: selected.rate,
      sapCode: selected.sap_code,
    });
    setShowEditDialog(true);
  };

  const handleEdit = async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      const body: Record<string, string> = {};
      if (editForm.value !== undefined) body.value = editForm.value;
      if (editForm.description !== undefined) body.description = editForm.description;
      if (editForm.datasheet !== undefined) body.datasheet_url = editForm.datasheet;
      if (editForm.manufacturer !== undefined) body.manufacturer = editForm.manufacturer;
      if (editForm.manufacturerPartNumber !== undefined) body.mpn = editForm.manufacturerPartNumber;
      if (editForm.category !== undefined) body.category = editForm.category;
      if (editForm.packageName !== undefined) body.package_name = editForm.packageName;
      if (editForm.vendor !== undefined) body.vendor = editForm.vendor;
      if (editForm.vendorPartNumber !== undefined) body.vendor_part_number = editForm.vendorPartNumber;
      if (editForm.massG !== undefined) body.mass_g = editForm.massG;
      if (editForm.rqjcCW !== undefined) body.rqjc_c_w = editForm.rqjcCW;
      if (editForm.rqjcTopCW !== undefined) body.rqjc_top_c_w = editForm.rqjcTopCW;
      if (editForm.tempMaxC !== undefined) body.temp_max_c = editForm.tempMaxC;
      if (editForm.tempMinC !== undefined) body.temp_min_c = editForm.tempMinC;
      if (editForm.powerDissipationW !== undefined) body.power_dissipation_w = editForm.powerDissipationW;
      if (editForm.rate !== undefined) body.rate = editForm.rate;
      if (editForm.sapCode !== undefined) body.sap_code = editForm.sapCode;

      const updated = await fetchJson<CatalogComponent>(`/api/catalog/components/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setSelected(updated);
      toast.success("Component updated");
      setShowEditDialog(false);
      refresh();
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Delete component ─────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      await fetchApi(`/api/catalog/components/${selected.id}`, { method: "DELETE" });
      toast.success("Component deleted");
      setShowDeleteConfirm(false);
      setSelected(null);
      refresh();
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Attach asset ─────────────────────────────────────────────────────
  const handleAttach = async () => {
    if (!selected || !showAttachDialog || !attachFile) return;
    setSubmitting(true);
    try {
      const assetType = showAttachDialog.assetType;
      const form = new FormData();
      form.append("file", attachFile);
      form.append("target_library", attachTargetLibrary || selected.name);

      let url = `/api/catalog/components/${selected.id}`;
      if (assetType === "symbol") url += "/symbol-import";
      else if (assetType === "footprint") url += "/footprint-import";
      else url += `/assets/${assetType}`;

      const resp = await fetchJson<SelectionRequiredResponse | ImportCompletedResponse>(url, {
        method: "POST",
        body: form,
      });

      if ("mode" in resp && resp.mode === "selection_required") {
        const symbols = resp.discovered_symbols ?? resp.discovered_footprints ?? [];
        setImportSelection({
          file: attachFile,
          targetLibrary: attachTargetLibrary || selected.name,
          options: symbols,
          selected: symbols[0] ?? "",
        });
        return;
      }

      toast.success("Asset attached");
      setShowAttachDialog(null);
      setAttachFile(null);
      setAttachTargetLibrary("");
      refresh();
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Confirm symbol selection from multi-symbol library ───────────────
  const handleConfirmSelection = async () => {
    if (!selected || !importSelection || !showAttachDialog) return;
    setSubmitting(true);
    try {
      const assetType = showAttachDialog.assetType;
      const form = new FormData();
      form.append("file", importSelection.file);
      form.append("target_library", importSelection.targetLibrary);
      if (assetType === "symbol") form.append("selected_symbol", importSelection.selected);
      else form.append("selected_footprint", importSelection.selected);

      const url = assetType === "symbol"
        ? `/api/catalog/components/${selected.id}/symbol-import`
        : `/api/catalog/components/${selected.id}/footprint-import`;

      await fetchJson(url, { method: "POST", body: form });
      toast.success("Asset attached");
      setImportSelection(null);
      setShowAttachDialog(null);
      setAttachFile(null);
      refresh();
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Detach asset ─────────────────────────────────────────────────────
  const handleDetach = async (assetType: string) => {
    if (!selected) return;
    setSubmitting(true);
    try {
      await fetchApi(`/api/catalog/components/${selected.id}/assets/${assetType}`, { method: "DELETE" });
      toast.success("Asset detached");
      setShowDetachConfirm(null);
      refresh();
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReleaseTransition = async (releaseStatus: WorkflowStage) => {
    if (!selected) return;
    setReleaseSubmitting(true);
    try {
      const updated = await fetchJson<CatalogComponent>(`/api/catalog/components/${selected.id}/release`, {
        method: "POST",
        body: JSON.stringify({ workflow_stage: releaseStatus }),
      });
      setSelected(updated);
      toast.success(`Revision moved to ${WORKFLOW_META[releaseStatus].label}`);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setReleaseSubmitting(false);
    }
  };

  const handleRegeneratePreviews = async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      const updated = await fetchJson<CatalogComponent>(`/api/catalog/components/${selected.id}/previews/regenerate`, {
        method: "POST",
      });
      setSelected(updated);
      setComponents((current) => current.map((component) => (component.id === updated.id ? updated : component)));
      const readyCount = updated.previews.filter((preview) => preview.status === "ready").length;
      const failedCount = updated.previews.filter((preview) => preview.status === "failed").length;
      if (readyCount > 0) {
        toast.success(`Preview regeneration finished (${readyCount} ready${failedCount ? `, ${failedCount} failed` : ""})`);
      } else {
        toast.error("Preview regeneration finished, but no previews were generated");
      }
      setRefreshKey((key) => key + 1);
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const transitionComponent = async (component: CatalogComponent, stage: WorkflowStage) => {
    setReleaseSubmitting(true);
    try {
      const updated = await fetchJson<CatalogComponent>(`/api/catalog/components/${component.id}/release`, {
        method: "POST",
        body: JSON.stringify({ workflow_stage: stage }),
      });
      if (selected?.id === component.id) setSelected(updated);
      toast.success(`${component.name} moved to ${WORKFLOW_META[stage].label}`);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setReleaseSubmitting(false);
    }
  };

  // ─── Open Attach Dialog ───────────────────────────────────────────────
  const openAttachDialog = async (assetType: "symbol" | "footprint" | "3dmodel" | "spice") => {
    setShowAttachDialog({ assetType });
    setAttachFile(null);
    setAttachTargetLibrary(selected?.library_name || selected?.name || "");
    setAttachTab("upload");
    setSelectedLink("");
    setSelectedLinkTargetLibrary(selected?.library_name || selected?.name || "");
    setSelectedLinkTargetName("");
    setAvailableLinks([]);

    try {
      const resp = await fetchJson<{files: string[]}>(`/api/catalog/assets/browse?asset_type=${assetType}`);
      setAvailableLinks(resp.files);
    } catch (err) {
      console.error("Failed to fetch available assets", err);
    }
  };

  // ─── Link Existing Asset ─────────────────────────────────────────────
  const handleLink = async () => {
    if (!selected || !showAttachDialog || !selectedLink) return;
    setSubmitting(true);
    try {
      const assetType = showAttachDialog.assetType;
      await fetchJson(`/api/catalog/components/${selected.id}/assets/${assetType}/link`, {
        method: "POST",
        body: JSON.stringify({
          file_path: selectedLink,
          target_library: selectedLinkTargetLibrary || selected.name,
          target_name: selectedLinkTargetName || selected.name,
        }),
      });
      toast.success("Asset linked successfully");
      setShowAttachDialog(null);
      refresh();
    } catch (err) {
      toast.error(getErrorMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const isAdmin = user?.role === "admin";

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="flex h-full bg-background text-foreground">
      {/* ── LEFT SIDEBAR ──────────────────────────────────────────────── */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-border/50 bg-card/30">
        <div className="px-4 py-3 border-b border-border/50">
          <h2 className="text-sm font-semibold text-foreground">Library Manager</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">{total} components</p>
        </div>

        <ScrollArea className="flex-1 px-2 py-2">
          {/* Category filters */}
          <div className="mt-1 mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            Categories
          </div>
          <button
            onClick={() => setFilterCategory(null)}
            className={cn(
              "w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs transition-colors mb-0.5",
              filterCategory === null
                ? "bg-primary/10 text-primary font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
            )}
          >
            <span>All Categories</span>
            {filterCategory === null && <Check className="h-3 w-3" />}
          </button>

          {categories.map((category) => {
            const cat = category.name;
            return (
            <button
              key={cat}
              onClick={() => setFilterCategory(cat === filterCategory ? null : cat)}
              className={cn(
                "w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs transition-colors mb-0.5",
                filterCategory === cat
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              )}
            >
              <span className="truncate">{cat || "Uncategorized"}</span>
              <span className="text-[10px]">{category.count}</span>
            </button>
            );
          })}
        </ScrollArea>

        {isAdmin && (
          <div className="p-2 border-t border-border/50">
            <Button
              size="sm"
              className="w-full h-8 text-xs"
              onClick={() => setShowNewDialog(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add Component
            </Button>
          </div>
        )}
      </aside>

      {/* ── MAIN TABLE PANE ───────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0 border-r border-border/50">
        {/* Toolbar */}
        <div className="border-b border-border/50 bg-card/20">
          <div className="flex min-w-0 items-center justify-between gap-2 px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="relative w-64 shrink-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search in ${filterCategory === null ? "all categories" : (filterCategory || "uncategorized")}…`}
                  className="h-8 pl-8 text-xs bg-secondary/40"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>

              <div className="h-4 w-px shrink-0 bg-border mx-2" />

              <div className="min-w-0 overflow-x-auto">
                {viewMode === "workflow" ? (
                  <div className="flex w-max items-center gap-1.5 rounded-md border border-border/50 bg-secondary/20 p-0.5">
                    {(["", "place_ready", "files_partial", "metadata_only"] as const).map((s) => {
                      const labels: Record<string, string> = {
                        "": "All Status",
                        place_ready: "Place Ready",
                        files_partial: "Partial",
                        metadata_only: "Metadata Only",
                      };
                      return (
                        <button
                          key={s}
                          onClick={() => setFilterState(s as AvailabilityState | "")}
                          className={cn(
                            "whitespace-nowrap rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                            filterState === s
                              ? "bg-primary text-primary-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                          )}
                        >
                          {labels[s]}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex w-max items-center gap-1.5 rounded-md border border-border/50 bg-secondary/20 p-0.5">
                    {(["", ...WORKFLOW_ORDER] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setFilterWorkflow(s as WorkflowStage | "")}
                        className={cn(
                          "whitespace-nowrap rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                          filterWorkflow === s
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                        )}
                      >
                        {s ? WORKFLOW_META[s].label : "All Workflow"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <div className="flex items-center gap-1.5 bg-secondary/20 p-0.5 rounded-md border border-border/50">
                {(["table", "workflow"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    className={cn(
                      "px-2.5 py-1 rounded text-[11px] font-medium transition-colors",
                      viewMode === mode
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                    )}
                  >
                    {mode === "table" ? "Table" : "Workflow"}
                  </button>
                ))}
              </div>
              <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={refresh}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <span className="min-w-[120px] text-right text-[11px] text-muted-foreground">
                {total === 0
                  ? "0 components"
                  : `${(currentPage - 1) * CATALOG_PAGE_SIZE + 1}-${Math.min(currentPage * CATALOG_PAGE_SIZE, total)} / ${total}`}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-b border-border/50 bg-background/60 px-3 py-2">
          <p className="text-[11px] text-muted-foreground">
            Page {currentPage} of {totalPages} · {CATALOG_PAGE_SIZE} components per page
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={loading || currentPage <= 1}
              onClick={() => setCurrentPage(1)}
            >
              First
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={loading || currentPage <= 1}
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={loading || currentPage >= totalPages}
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
            >
              Next
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={loading || currentPage >= totalPages}
              onClick={() => setCurrentPage(totalPages)}
            >
              Last
            </Button>
          </div>
        </div>

        {/* Table / Workflow */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {viewMode === "table" ? (
            <>
              <div className="grid grid-cols-[2fr_1.2fr_1fr_1fr_1fr_1fr] gap-x-3 px-3 py-2 border-b border-border/50 bg-card/10 text-[10px]">
                <SortButton col="name" current={sortKey} dir={sortDir} onClick={() => toggleSort("name")}>Part Name / MPN</SortButton>
                <SortButton col="manufacturer" current={sortKey} dir={sortDir} onClick={() => toggleSort("manufacturer")}>Manufacturer</SortButton>
                <SortButton col="category" current={sortKey} dir={sortDir} onClick={() => toggleSort("category")}>Category</SortButton>
                <SortButton col="package_name" current={sortKey} dir={sortDir} onClick={() => toggleSort("package_name")}>Package</SortButton>
                <SortButton col="availability_state" current={sortKey} dir={sortDir} onClick={() => toggleSort("availability_state")}>Availability</SortButton>
                <SortButton col="workflow_stage" current={sortKey} dir={sortDir} onClick={() => toggleSort("workflow_stage")}>Workflow</SortButton>
              </div>

              <ScrollArea className="flex-1">
                {loading ? (
                  <div className="flex items-center justify-center py-16 gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading catalog…
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-2 text-sm text-muted-foreground">
                    <PackageSearch className="h-8 w-8 opacity-30" />
                    <p>No components found</p>
                    {query && <p className="text-xs">Try clearing the search query.</p>}
                  </div>
                ) : (
                  filtered.map((comp) => {
                    const isSelected = selected?.id === comp.id;
                    return (
                      <button
                        key={comp.id}
                        onClick={() => setSelected(isSelected ? null : comp)}
                        className={cn(
                          "w-full grid grid-cols-[2fr_1.2fr_1fr_1fr_1fr_1fr] gap-x-3 px-3 py-2.5 text-left border-b border-border/30 transition-colors",
                          isSelected
                            ? "bg-primary/8 border-l-2 border-l-primary"
                            : "hover:bg-secondary/30"
                        )}
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">{comp.name}</p>
                          {comp.mpn && comp.mpn !== comp.name && (
                            <p className="text-[10px] text-muted-foreground truncate">{comp.mpn}</p>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate self-center">{comp.manufacturer || "—"}</p>
                        <p className="text-[11px] text-muted-foreground truncate self-center">{comp.category || "—"}</p>
                        <p className="text-[11px] text-muted-foreground truncate self-center">{comp.package_name || "—"}</p>
                        <div className="self-center">
                          <AvailabilityBadge state={comp.availability_state} />
                        </div>
                        <div className="self-center">
                          <ReleaseBadge status={workflowStage(comp)} />
                        </div>
                      </button>
                    );
                  })
                )}
              </ScrollArea>
            </>
          ) : (
            <ScrollArea className="flex-1">
              {loading ? (
                <div className="flex items-center justify-center py-16 gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading workflow…
                </div>
              ) : (
                <div className="grid grid-cols-6 gap-3 p-3 min-w-[1080px]">
                  {WORKFLOW_ORDER.map((stage) => {
                    const stageItems = filtered.filter((comp) => workflowStage(comp) === stage);
                    return (
                      <div key={stage} className="flex min-h-[560px] flex-col rounded-lg border border-border/50 bg-card/20">
                        <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
                          <ReleaseBadge status={stage} />
                          <span className="text-[11px] text-muted-foreground">{stageItems.length}</span>
                        </div>
                        <div className="flex-1 space-y-2 p-2">
                          {stageItems.length === 0 ? (
                            <div className="rounded-md border border-dashed border-border/50 p-3 text-center text-[11px] text-muted-foreground">
                              No parts
                            </div>
                          ) : (
                            stageItems.map((comp) => {
                              const isSelected = selected?.id === comp.id;
                              const nextStages = WORKFLOW_TRANSITIONS[workflowStage(comp)];
                              return (
                                <div
                                  key={comp.id}
                                  className={cn(
                                    "rounded-md border border-border/50 bg-background/70 p-2 transition-colors",
                                    isSelected ? "border-primary bg-primary/5" : "hover:bg-secondary/30"
                                  )}
                                >
                                  <button className="w-full text-left" onClick={() => setSelected(isSelected ? null : comp)}>
                                    <p className="truncate text-xs font-medium text-foreground">{comp.name}</p>
                                    <p className="truncate text-[10px] text-muted-foreground">{comp.mpn || comp.manufacturer || "No MPN"}</p>
                                    <div className="mt-2 flex items-center justify-between gap-2">
                                      <AvailabilityBadge state={comp.availability_state} />
                                      {comp.previews.some((p) => p.status === "failed") && (
                                        <span className="text-[10px] text-amber-400">Preview issue</span>
                                      )}
                                    </div>
                                    {comp.missing_assets.length > 0 && (
                                      <p className="mt-1 text-[10px] text-red-400">
                                        Missing {comp.missing_assets.join(", ")}
                                      </p>
                                    )}
                                  </button>
                                  {isAdmin && nextStages.length > 0 && (
                                    <div className="mt-2 flex flex-wrap gap-1">
                                      {nextStages.map((next) => (
                                        <Button
                                          key={next}
                                          size="sm"
                                          variant="outline"
                                          className="h-6 px-2 text-[10px]"
                                          disabled={releaseSubmitting}
                                          onClick={() => transitionComponent(comp, next)}
                                        >
                                          {WORKFLOW_META[next].label}
                                        </Button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          )}
        </div>
      </div>

      {/* ── RIGHT DETAIL PANEL ────────────────────────────────────────── */}
      {selected ? (
        <aside className="w-80 shrink-0 flex flex-col bg-card/20">
          {/* Header */}
          <div className="px-4 pt-4 pb-3 border-b border-border/50">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground truncate">{selected.name}</h3>
                <p className="text-[11px] text-muted-foreground truncate">{selected.manufacturer} · {selected.mpn}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {isAdmin && (
                  <>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Edit" onClick={openEdit}>
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                      title="Delete"
                      onClick={() => setShowDeleteConfirm(true)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setSelected(null)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <AvailabilityBadge state={selected.availability_state} />
              <ReleaseBadge status={workflowStage(selected)} />
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="px-4 py-3 space-y-5">
              {/* SVG Previews */}
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Previews</p>
                  {isAdmin && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={submitting}
                      onClick={handleRegeneratePreviews}
                    >
                      {submitting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                      Regenerate
                    </Button>
                  )}
                </div>
                {selected.previews.some((p) => p.status === "ready") ? (
                  <div className="flex gap-2">
                    {(["symbol", "footprint"] as const).map((kind) => {
                      const has = selected.previews.some((p) => p.kind === kind && p.status === "ready");
                      if (!has) return null;
                      return (
                        <div key={kind} className="h-24 flex-1 overflow-hidden rounded-md border border-border/50 bg-secondary/20">
                          <SvgPreview component={selected} kind={kind} />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border/50 p-3 text-[11px] text-muted-foreground">
                    No generated previews available.
                    {selected.previews.some((p) => p.status === "failed") ? (
                      <div className="mt-2 space-y-1 text-amber-400">
                        {selected.previews
                          .filter((p) => p.status === "failed")
                          .map((preview) => (
                            <p key={preview.id}>
                              {preview.kind}: {preview.generation_error || "generation failed"}
                            </p>
                          ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              {/* Core metadata */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">Metadata</p>
                <dl className="space-y-0">
                  <FieldRow label="Value" value={selected.value} />
                  <FieldRow label="Description" value={selected.description} />
                  <FieldRow label="Category" value={selected.category} />
                  <FieldRow label="Package" value={selected.package_name} />
                  {selected.datasheet_url && (
                    <div className="grid grid-cols-[120px_1fr] gap-x-3 py-1">
                      <dt className="text-[11px] font-medium text-muted-foreground">Datasheet</dt>
                      <dd>
                        <a
                          href={selected.datasheet_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                        >
                          Open <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      </dd>
                    </div>
                  )}
                  <FieldRow label="Vendor" value={selected.vendor} />
                  <FieldRow label="Vendor P/N" value={selected.vendor_part_number} />
                  <FieldRow label="SAP Code" value={selected.sap_code} />
                </dl>
              </div>

              {/* Thermal/electrical */}
              {(selected.mass_g || selected.temp_max_c || selected.power_dissipation_w) && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">
                    Thermal / Electrical
                  </p>
                  <dl className="space-y-0">
                    <FieldRow label="Mass" value={selected.mass_g ? `${selected.mass_g} g` : ""} />
                    <FieldRow label="θJC" value={selected.rqjc_c_w ? `${selected.rqjc_c_w} °C/W` : ""} />
                    <FieldRow label="Temp Max" value={selected.temp_max_c ? `${selected.temp_max_c} °C` : ""} />
                    <FieldRow label="Temp Min" value={selected.temp_min_c ? `${selected.temp_min_c} °C` : ""} />
                    <FieldRow label="Power Diss." value={selected.power_dissipation_w ? `${selected.power_dissipation_w} W` : ""} />
                  </dl>
                </div>
              )}

              {/* Stock */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">Stock</p>
                <p className="text-[11px] text-muted-foreground italic">N/A — PLM sync not configured</p>
              </div>

              {isAdmin && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">
                    Release Workflow
                  </p>
                  <div className="space-y-2">
                    <div className="rounded-md border border-border/50 bg-secondary/20 p-3 text-[11px] text-muted-foreground">
                      Current revision is in <span className="font-medium text-foreground">{WORKFLOW_META[workflowStage(selected)].label}</span>.
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {WORKFLOW_TRANSITIONS[workflowStage(selected)].map((next) => (
                        <Button
                          key={next}
                          size="sm"
                          variant={next === "archived" ? "destructive" : "outline"}
                          disabled={releaseSubmitting}
                          onClick={() => handleReleaseTransition(next)}
                        >
                          Move to {WORKFLOW_META[next].label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* KiCAD Files */}
              {isAdmin && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">KiCAD Files</p>
                  <div className="space-y-1.5">
                    {(["symbol", "footprint", "3dmodel", "spice"] as const).map((type) => {
                      const asset = selected.assets.find((a) => a.asset_type === type);
                      return (
                        <AssetRow
                          key={type}
                          type={type}
                          asset={asset}
                          onDetach={(t) => setShowDetachConfirm(t)}
                          onAttach={(t) => openAttachDialog(t as "symbol" | "footprint" | "3dmodel" | "spice")}
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Version info */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">Version</p>
                <dl>
                  <FieldRow label="Version" value={selected.version} />
                  <FieldRow label="Library" value={selected.library_name} />
                  <FieldRow label="Symbol" value={selected.symbol_name} />
                </dl>
              </div>
            </div>
          </ScrollArea>
        </aside>
      ) : (
        <aside className="w-80 shrink-0 flex items-center justify-center bg-card/10 text-muted-foreground">
          <div className="flex flex-col items-center gap-2 text-center px-8">
            <FileText className="h-8 w-8 opacity-20" />
            <p className="text-xs">Select a component to view details</p>
          </div>
        </aside>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          DIALOGS
      ═══════════════════════════════════════════════════════════════ */}

      {/* ── Create dialog ─────────────────────────────────────────────── */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Component</DialogTitle>
            <DialogDescription>
              Create a new component manually or bulk import metadata from CSV.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 mb-4 border-b pb-2">
            <Button
              variant={newDialogTab === "manual" ? "default" : "ghost"}
              size="sm"
              onClick={() => setNewDialogTab("manual")}
            >
              Manual Entry
            </Button>
            <Button
              variant={newDialogTab === "csv" ? "default" : "ghost"}
              size="sm"
              onClick={() => setNewDialogTab("csv")}
            >
              CSV Import
            </Button>
          </div>

          {newDialogTab === "manual" ? (
            <>
              <ComponentForm form={newForm} onChange={(k, v) => setNewForm((f) => ({ ...f, [k]: v }))} categories={categoryNames} />
              <DialogFooter className="mt-4">
                <Button variant="outline" onClick={() => setShowNewDialog(false)}>Cancel</Button>
                <Button onClick={handleCreate} disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Create
                </Button>
              </DialogFooter>
            </>
          ) : (
            <div className="space-y-6">
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-foreground">Import Metadata</h4>
                <p className="text-xs text-muted-foreground">
                  Upload a CSV file containing at least an <code>mpn</code> column. Other optional columns include:
                  <code>value</code>, <code>description</code>, <code>manufacturer</code>, <code>category</code>, <code>package_name</code>,
                  <code>datasheet</code>, <code>vendor</code>, <code>vpn</code>, <code>mass_g</code>.
                </p>
                <FilePicker
                  id="csv-file"
                  label="Metadata CSV File"
                  accept=".csv"
                  file={csvFile}
                  placeholder="Choose CSV file…"
                  onChange={setCsvFile}
                />
                <Button onClick={handleCsvImport} disabled={submitting || !csvFile}>
                  {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Import Metadata
                </Button>
              </div>

              <div className="space-y-3 border-t pt-4">
                <h4 className="text-sm font-semibold text-foreground">Sync Stock</h4>
                <p className="text-xs text-muted-foreground">
                  Upload a CSV file containing <code>mpn</code>, <code>stock_quantity</code>, <code>stock_uom</code>, and <code>inventory_status</code>.
                </p>
                <FilePicker
                  id="stock-csv-file"
                  label="Stock Sync CSV File"
                  accept=".csv"
                  file={stockCsvFile}
                  placeholder="Choose CSV file…"
                  onChange={setStockCsvFile}
                />
                <Button onClick={handleStockCsvImport} disabled={submitting || !stockCsvFile}>
                  {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Sync Stock
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Edit dialog ───────────────────────────────────────────────── */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Component</DialogTitle>
            <DialogDescription>Update metadata for {selected?.name}.</DialogDescription>
          </DialogHeader>

          <ComponentForm
            categories={categoryNames}
            form={{
              value: editForm.value ?? "",
              description: editForm.description ?? "",
              datasheet: editForm.datasheet ?? "",
              manufacturer: editForm.manufacturer ?? "",
              manufacturerPartNumber: editForm.manufacturerPartNumber ?? "",
              category: editForm.category ?? "",
              packageName: editForm.packageName ?? "",
              vendor: editForm.vendor ?? "",
              vendorPartNumber: editForm.vendorPartNumber ?? "",
              massG: editForm.massG ?? "",
              rqjcCW: editForm.rqjcCW ?? "",
              rqjcTopCW: editForm.rqjcTopCW ?? "",
              tempMaxC: editForm.tempMaxC ?? "",
              tempMinC: editForm.tempMinC ?? "",
              powerDissipationW: editForm.powerDissipationW ?? "",
              rate: editForm.rate ?? "",
              sapCode: editForm.sapCode ?? "",
            }}
            onChange={(k, v) => setEditForm((f) => ({ ...f, [k]: v }))}
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ────────────────────────────────────────────── */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Component</DialogTitle>
            <DialogDescription>
              This will permanently remove <strong>{selected?.name}</strong> and all associated
              assets from the catalog. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={submitting}
            >
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Attach asset dialog ───────────────────────────────────────── */}
      <Dialog
        open={!!showAttachDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowAttachDialog(null);
            setAttachFile(null);
            setImportSelection(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Attach {showAttachDialog ? ASSET_LABELS[showAttachDialog.assetType] : ""}
            </DialogTitle>
            <DialogDescription>
              Upload a new file or link an existing file to <strong>{selected?.name}</strong>.
            </DialogDescription>
          </DialogHeader>

          {!importSelection && (
            <div className="flex items-center gap-2 mb-2 border-b pb-2">
              <Button
                variant={attachTab === "upload" ? "default" : "ghost"}
                size="sm"
                onClick={() => setAttachTab("upload")}
              >
                Upload New
              </Button>
              <Button
                variant={attachTab === "link" ? "default" : "ghost"}
                size="sm"
                onClick={() => setAttachTab("link")}
              >
                Choose Existing
              </Button>
            </div>
          )}

          {importSelection ? (
            // Symbol selection UI
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Multiple symbols found. Select one to import:
              </p>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {importSelection.options.map((opt) => (
                  <button
                    key={opt}
                    onClick={() => setImportSelection((s) => s ? { ...s, selected: opt } : s)}
                    className={cn(
                      "w-full text-left px-3 py-2 rounded-md text-sm border transition-colors",
                      importSelection.selected === opt
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:border-primary/50"
                    )}
                  >
                    {opt}
                  </button>
                ))}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setImportSelection(null)}>Back</Button>
                <Button onClick={handleConfirmSelection} disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Import Selected
                </Button>
              </DialogFooter>
            </div>
          ) : attachTab === "upload" ? (
            <div className="space-y-4">
              <FilePicker
                id="attach-file"
                label="File"
                accept={
                  showAttachDialog?.assetType === "symbol"
                    ? ".kicad_sym"
                    : showAttachDialog?.assetType === "footprint"
                    ? ".kicad_mod,.zip"
                    : showAttachDialog?.assetType === "3dmodel"
                    ? ".step,.stp"
                    : ".sp,.cir,.spice"
                }
                file={attachFile}
                placeholder="Choose file…"
                onChange={setAttachFile}
              />
              <div className="space-y-1">
                <Label className="text-xs">Target Library Name</Label>
                <Input
                  value={attachTargetLibrary}
                  onChange={(e) => setAttachTargetLibrary(e.target.value)}
                  placeholder={selected?.library_name || selected?.name || "Prism"}
                  className="h-8 text-xs"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowAttachDialog(null)}>Cancel</Button>
                <Button onClick={handleAttach} disabled={submitting || !attachFile}>
                  {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Attach
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1">
                <Label className="text-xs">Existing File in Storage</Label>
                {availableLinks.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground p-2 border border-border/50 rounded bg-secondary/10">
                    No matching files found in the storage directory for this asset type.
                  </p>
                ) : (
                  <Select value={selectedLink} onValueChange={setSelectedLink}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Select a file..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {Object.entries(
                        availableLinks.reduce((acc, p) => {
                          const parts = p.split("/");
                          const group = parts.length > 1 ? parts[0] : "Root";
                          if (!acc[group]) acc[group] = [];
                          acc[group].push(p);
                          return acc;
                        }, {} as Record<string, string[]>)
                      ).map(([group, paths]) => (
                        <SelectGroup key={group}>
                          <SelectLabel className="text-[10px] text-muted-foreground bg-secondary/20">{group}</SelectLabel>
                          {paths.map((p) => (
                            <SelectItem key={p} value={p} className="text-xs">
                              {p.split("/").slice(1).join("/") || p}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {(showAttachDialog?.assetType === "symbol" || showAttachDialog?.assetType === "footprint") && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Target Library (Optional)</Label>
                    <Input
                      value={selectedLinkTargetLibrary}
                      onChange={(e) => setSelectedLinkTargetLibrary(e.target.value)}
                      placeholder="Auto-inferred..."
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">
                      {showAttachDialog?.assetType === "symbol" ? "Symbol" : "Footprint"} Name (Optional)
                    </Label>
                    <Input
                      value={selectedLinkTargetName}
                      onChange={(e) => setSelectedLinkTargetName(e.target.value)}
                      placeholder="Auto-inferred..."
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => setShowAttachDialog(null)}>Cancel</Button>
                <Button onClick={handleLink} disabled={submitting || !selectedLink}>
                  {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Link Asset
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Detach confirm ────────────────────────────────────────────── */}
      <Dialog open={!!showDetachConfirm} onOpenChange={(open) => { if (!open) setShowDetachConfirm(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Detach {showDetachConfirm ? ASSET_LABELS[showDetachConfirm] : ""}</DialogTitle>
            <DialogDescription>
              This will remove the {showDetachConfirm} asset from{" "}
              <strong>{selected?.name}</strong>. The file on disk is not deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDetachConfirm(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={submitting}
              onClick={async () => {
                if (showDetachConfirm) await handleDetach(showDetachConfirm);
                setShowDetachConfirm(null);
              }}
            >
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Detach
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Component form (shared by create + edit) ─────────────────────────────

function FormField({
  id,
  label,
  required,
  value,
  placeholder,
  onChange,
  type = "text",
  list,
}: {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  type?: string;
  list?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label} {required && <span className="text-red-400">*</span>}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 text-xs"
        list={list}
      />
    </div>
  );
}

function ComponentForm({
  form,
  onChange,
  categories,
}: {
  form: NewComponentFormState;
  onChange: (key: keyof NewComponentFormState, value: string) => void;
  categories: string[];
}) {
  return (
    <div className="space-y-5">
      {/* Identity */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Identity</p>
        <div className="grid grid-cols-2 gap-3">
          <FormField id="cf-mpn" label="MPN" required value={form.manufacturerPartNumber} onChange={(v) => onChange("manufacturerPartNumber", v)} placeholder="GRM188R61C106KE69" />
          <FormField id="cf-value" label="Value" required value={form.value} onChange={(v) => onChange("value", v)} placeholder="10uF 16V" />
          <FormField id="cf-mfr" label="Manufacturer" required value={form.manufacturer} onChange={(v) => onChange("manufacturer", v)} placeholder="Murata" />
          <div>
            <FormField id="cf-category" label="Category" required value={form.category} onChange={(v) => onChange("category", v)} placeholder="Capacitors" list="cf-categories-list" />
            <datalist id="cf-categories-list">
              {categories.filter(Boolean).map((cat) => (
                <option key={cat} value={cat} />
              ))}
            </datalist>
          </div>
          <FormField id="cf-pkg" label="Package" value={form.packageName} onChange={(v) => onChange("packageName", v)} placeholder="0402" />
          <FormField id="cf-datasheet" label="Datasheet URL" required value={form.datasheet} onChange={(v) => onChange("datasheet", v)} placeholder="https://…" type="url" />
        </div>
      </div>

      {/* Description */}
      <div>
        <Label htmlFor="cf-desc" className="text-xs">Description <span className="text-red-400">*</span></Label>
        <Textarea
          id="cf-desc"
          value={form.description}
          onChange={(e) => onChange("description", e.target.value)}
          placeholder="General purpose MLCC ceramic capacitor…"
          className="mt-1 text-xs resize-none h-16"
        />
      </div>

      {/* Procurement */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Procurement</p>
        <div className="grid grid-cols-2 gap-3">
          <FormField id="cf-vendor" label="Vendor" value={form.vendor} onChange={(v) => onChange("vendor", v)} placeholder="Digi-Key" />
          <FormField id="cf-vpn" label="Vendor P/N" value={form.vendorPartNumber} onChange={(v) => onChange("vendorPartNumber", v)} placeholder="490-10505-1-ND" />
          <FormField id="cf-sap" label="SAP Code" value={form.sapCode} onChange={(v) => onChange("sapCode", v)} placeholder="SAP-XXXX" />
          <FormField id="cf-rate" label="Rate" value={form.rate} onChange={(v) => onChange("rate", v)} placeholder="" />
        </div>
      </div>

      {/* Thermal */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Thermal / Mechanical</p>
        <div className="grid grid-cols-3 gap-3">
          <FormField id="cf-mass" label="Mass (g)" value={form.massG} onChange={(v) => onChange("massG", v)} placeholder="0.01" />
          <FormField id="cf-tmax" label="Temp Max (°C)" value={form.tempMaxC} onChange={(v) => onChange("tempMaxC", v)} placeholder="125" />
          <FormField id="cf-tmin" label="Temp Min (°C)" value={form.tempMinC} onChange={(v) => onChange("tempMinC", v)} placeholder="-40" />
          <FormField id="cf-rqjc" label="θJC (°C/W)" value={form.rqjcCW} onChange={(v) => onChange("rqjcCW", v)} placeholder="" />
          <FormField id="cf-rqjct" label="θJC-top (°C/W)" value={form.rqjcTopCW} onChange={(v) => onChange("rqjcTopCW", v)} placeholder="" />
          <FormField id="cf-pdis" label="Power Diss. (W)" value={form.powerDissipationW} onChange={(v) => onChange("powerDissipationW", v)} placeholder="" />
        </div>
      </div>
    </div>
  );
}
