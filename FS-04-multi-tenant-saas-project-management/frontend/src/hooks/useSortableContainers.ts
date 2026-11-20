import {
  closestCenter, getFirstCollision, KeyboardSensor, PointerSensor, pointerWithin, rectIntersection, useSensor,
  useSensors, type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useCallback, useEffect, useRef, useState } from "react";

export type Containers = Record<string, string[]>;

export interface DropResult {
  id: string;
  from: string;
  to: string;
  prevId: string | null;
  nextId: string | null;
}

/**
 * Multi-container sortable state for dnd-kit (Kanban columns, sprint lists).
 * Items move between containers live during the drag (onDragOver) and the final position is
 * reported once on drop with its new neighbours, which is exactly what the move API needs.
 */
export function useSortableContainers(serverItems: Containers, onDrop: (result: DropResult) => void) {
  const [items, setItems] = useState<Containers>(serverItems);
  const [activeId, setActiveId] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const originRef = useRef<string | null>(null);
  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const movedToNewContainer = useRef(false);

  // Follow the server (and optimistic cache) whenever nobody is dragging.
  useEffect(() => {
    if (!activeId) setItems(serverItems);
  }, [serverItems, activeId]);

  const findContainer = useCallback((id: UniqueIdentifier): string | undefined => {
    const key = String(id);
    const current = itemsRef.current;
    if (key in current) return key;
    return Object.keys(current).find((container) => current[container].includes(key));
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Pointer first (feels natural across columns), then the closest card inside that column.
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      const pointerHits = pointerWithin(args);
      const hits = pointerHits.length > 0 ? pointerHits : rectIntersection(args);
      let overId = getFirstCollision(hits, "id");
      if (overId != null) {
        const current = itemsRef.current;
        if (String(overId) in current) {
          const containerItems = current[String(overId)];
          if (containerItems.length > 0) {
            const closest = closestCenter({
              ...args,
              droppableContainers: args.droppableContainers.filter(
                (c) => c.id !== overId && containerItems.includes(String(c.id)),
              ),
            })[0]?.id;
            if (closest != null) overId = closest;
          }
        }
        lastOverId.current = overId;
        return [{ id: overId }];
      }
      if (movedToNewContainer.current) lastOverId.current = activeId;
      return lastOverId.current ? [{ id: lastOverId.current }] : [];
    },
    [activeId],
  );

  useEffect(() => {
    requestAnimationFrame(() => {
      movedToNewContainer.current = false;
    });
  }, [items]);

  const onDragStart = useCallback(
    ({ active }: DragStartEvent) => {
      setActiveId(String(active.id));
      originRef.current = findContainer(active.id) ?? null;
    },
    [findContainer],
  );

  const onDragOver = useCallback(
    ({ active, over }: DragOverEvent) => {
      if (!over) return;
      const from = findContainer(active.id);
      const to = findContainer(over.id);
      if (!from || !to || from === to) return;
      setItems((prev) => {
        const toItems = prev[to];
        const overKey = String(over.id);
        let index: number;
        if (overKey in prev) {
          index = toItems.length;
        } else {
          const overIndex = toItems.indexOf(overKey);
          const translated = active.rect.current.translated;
          const below = translated ? translated.top > over.rect.top + over.rect.height / 2 : false;
          index = overIndex >= 0 ? overIndex + (below ? 1 : 0) : toItems.length;
        }
        movedToNewContainer.current = true;
        const id = String(active.id);
        return {
          ...prev,
          [from]: prev[from].filter((item) => item !== id),
          [to]: [...toItems.slice(0, index), id, ...toItems.slice(index)],
        };
      });
    },
    [findContainer],
  );

  const reset = useCallback(() => {
    setActiveId(null);
    setItems(serverItems);
  }, [serverItems]);

  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      const id = String(active.id);
      const container = findContainer(id);
      const origin = originRef.current;
      if (!over || !container || !origin) {
        reset();
        return;
      }
      let next = itemsRef.current;
      const overContainer = findContainer(over.id);
      if (overContainer === container) {
        const list = next[container];
        const oldIndex = list.indexOf(id);
        const overKey = String(over.id);
        const newIndex = overKey in next ? list.length - 1 : list.indexOf(overKey);
        if (newIndex >= 0 && oldIndex !== newIndex) {
          next = { ...next, [container]: arrayMove(list, oldIndex, newIndex) };
        }
      }
      setItems(next);
      setActiveId(null);

      const list = next[container];
      const index = list.indexOf(id);
      const prevId = list[index - 1] ?? null;
      const nextId = list[index + 1] ?? null;
      const before = serverItems[origin] ?? [];
      const beforeIndex = before.indexOf(id);
      const unchanged =
        origin === container && (before[beforeIndex - 1] ?? null) === prevId && (before[beforeIndex + 1] ?? null) === nextId;
      if (!unchanged) onDrop({ id, from: origin, to: container, prevId, nextId });
    },
    [findContainer, onDrop, reset, serverItems],
  );

  return {
    items,
    activeId,
    sensors,
    collisionDetection,
    handlers: { onDragStart, onDragOver, onDragEnd, onDragCancel: reset },
  };
}
