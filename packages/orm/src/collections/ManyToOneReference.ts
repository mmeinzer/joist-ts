import { Entity, EntityConstructor, getMetadata, IdOf, isEntity } from "../EntityManager";
import { ensureNotDeleted, fail, getEm, maybeResolveReferenceToId, Reference, setField } from "../index";
import { OneToManyCollection } from "./OneToManyCollection";
import { AbstractRelationImpl } from "./AbstractRelationImpl";

/**
 * Manages a foreign key from one entity to another, i.e. `Book.author --> Author`.
 *
 * We keep the current `author` / `author_id` value in the `__orm.data` hash, where the
 * current value could be either the (string) author id from the database, or an entity
 * `Author` that the user has set.
 */
export class ManyToOneReference<T extends Entity, U extends Entity, N extends never | undefined>
  extends AbstractRelationImpl<U>
  implements Reference<T, U, N> {
  private loaded!: U | N;
  // We need a separate boolean to b/c loaded == undefined can still mean "isLoaded" for nullable fks.
  private isLoaded = false;
  private isCascadeDelete: boolean;

  constructor(
    private entity: T,
    public otherType: EntityConstructor<U>,
    private fieldName: keyof T,
    public otherFieldName: keyof U,
    private notNull: boolean,
  ) {
    super();
    this.isCascadeDelete = getMetadata(entity).config.__data.cascadeDeleteFields.includes(fieldName as any);
  }

  async load(opts?: { withDeleted?: boolean }): Promise<U | N> {
    ensureNotDeleted(this.entity, { ignore: "pending" });
    const current = this.current();
    // Resolve the id to an entity
    if (!isEntity(current) && current !== undefined) {
      this.loaded = ((await getEm(this.entity).load(this.otherType, current)) as any) as U;
    }
    this.isLoaded = true;
    return this.filterDeleted(this.loaded, opts);
  }

  set(other: U | N): void {
    this.setImpl(other);
  }

  isSet(): boolean {
    return this.current() !== undefined;
  }

  private doGet(opts?: { withDeleted?: boolean }): U | N {
    ensureNotDeleted(this.entity, { ignore: "pending" });
    // This should only be callable in the type system if we've already resolved this to an instance
    if (!this.isLoaded) {
      throw new Error(`${this.entity}.${this.fieldName} was not loaded`);
    }

    return this.filterDeleted(this.loaded, opts);
  }

  get getWithDeleted(): U | N {
    return this.doGet({ withDeleted: true });
  }

  get get(): U | N {
    return this.doGet({ withDeleted: false });
  }

  get id(): IdOf<U> | undefined {
    ensureNotDeleted(this.entity, { ignore: "pending" });
    return maybeResolveReferenceToId(this.current()) as IdOf<U> | undefined;
  }

  get idOrFail(): IdOf<U> {
    ensureNotDeleted(this.entity, { ignore: "pending" });
    return this.id || fail("Reference is unset or assigned to a new entity");
  }

  // private impl

  setFromOpts(other: U): void {
    this.setImpl(other);
  }

  initializeForNewEntity(): void {
    // Our codegen'd Opts type will ensure our field is inititalized if necessary/notNull
    this.isLoaded = true;
  }

  async refreshIfLoaded(): Promise<void> {
    // TODO We should remember what load hints have been applied to this collection and re-apply them.
    if (this.isLoaded) {
      const current = this.current();
      if (typeof current === "string") {
        this.loaded = ((await getEm(this.entity).load(this.otherType, current)) as any) as U;
      } else {
        this.loaded = current;
      }
    }
  }

  onEntityDelete(): void {
    if (this.isCascadeDelete) {
      const current = this.current({ withDeleted: true });
      if (current !== undefined && typeof current !== "string") {
        getEm(this.entity).delete(current as U);
      }
    }
  }

  async onEntityDeletedAndFlushing(): Promise<void> {
    const current = await this.load({ withDeleted: true });
    if (current !== undefined) {
      const o2m = ((current as U)[this.otherFieldName] as any) as OneToManyCollection<U, T>;
      o2m.remove(this.entity, { requireLoaded: false });
    }
    setField(this.entity, this.fieldName as string, undefined);
    this.loaded = undefined as any;
    this.isLoaded = true;
  }

  // Internal method used by OneToManyCollection
  setImpl(other: U | N): void {
    if (this.isLoaded && other === this.loaded) {
      return;
    }

    const previousLoaded = this.loaded;

    ensureNotDeleted(this.entity, { ignore: "pending" });

    // Prefer to keep the id in our data hash, but if this is a new entity w/o an id, use the entity itself
    setField(this.entity, this.fieldName as string, other?.id ?? other);
    this.loaded = other;
    this.isLoaded = true;

    // If had an existing value, remove us from its collection
    if (previousLoaded) {
      const previousCollection = ((previousLoaded as U)[this.otherFieldName] as any) as OneToManyCollection<U, T>;
      previousCollection.removeIfLoaded(this.entity);
    }
    if (other !== undefined) {
      const newCollection = ((other as U)[this.otherFieldName] as any) as OneToManyCollection<U, T>;
      newCollection.add(this.entity);
    }
  }

  // We need to keep U in data[fieldName] to handle entities without an id assigned yet.
  current(opts?: { withDeleted?: boolean }): U | string | N {
    const current = this.entity.__orm.data[this.fieldName];
    if (current !== undefined && isEntity(current)) {
      return this.filterDeleted(current as U, opts);
    }
    return current;
  }

  private filterDeleted(entity: U | N, opts?: { withDeleted?: boolean }): U | N {
    return opts?.withDeleted === true || entity === undefined || !entity.isDeletedEntity ? entity : (undefined as N);
  }

  public toString(): string {
    return `ManyToOneReference(entity: ${this.entity}, fieldName: ${this.fieldName}, otherType: ${this.otherType.name}, otherFieldName: ${this.otherFieldName}, id: ${this.id})`;
  }
}
